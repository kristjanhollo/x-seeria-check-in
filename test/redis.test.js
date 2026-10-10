const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const axios = require('axios');
const { Redis } = require('@upstash/redis');
const { available, startRedisHarness } = require('./redisHarness');
const store = require('../lib/stateStore');
const logic = require('../lib/competitionLogic');
const handler = require('../api/competition');
const health = require('../api/health');

function response() {
    return { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
async function request(body, method = 'POST') {
    const res = response();
    await handler({ method, body }, res);
    return res;
}
function context(payload) {
    return { competitionId: payload.currentCompetitionId, competitionRevision: payload.competitionRevision, rosterVersion: payload.rosterVersion };
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe('real Redis with the actual Upstash SDK (requires redis-server and redis-cli)', { skip: !available }, () => {
    let harness;
    let redis;
    let originalAxiosGet;
    let prefix;

    before(async () => {
        harness = await startRedisHarness();
        process.env.UPSTASH_REDIS_REST_URL = harness.url;
        process.env.UPSTASH_REDIS_REST_TOKEN = 'local-test-token';
        delete process.env.KV_REST_API_URL;
        delete process.env.KV_REST_API_TOKEN;
        process.env.VERCEL_ENV = 'production';
        process.env.VERCEL = '1';
        redis = store.getRedis();
        originalAxiosGet = axios.get;
    });
    after(async () => { axios.get = originalAxiosGet; if (harness) await harness.close(); });
    beforeEach(async () => {
        harness.fail = false;
        prefix = 'checkin:test:' + randomUUID() + ':';
        process.env.CHECKIN_REDIS_PREFIX = prefix;
        delete process.env.CHECKIN_ADMIN_PIN;
        axios.get = async () => ({ data: { Competition: { Name: 'Test event', Results: [{ Name: 'Alice', Group: 1 }, { Name: 'Bob', Group: 1 }] } } });
    });
    async function roster(id, names = ['Alice', 'Bob']) {
        await store.setRoster(id, { title: 'Event ' + id, version: randomUUID(), lastUpdated: new Date().toISOString(), groups: [{ groupName: 'Group 1', users: names.map(username => ({ username })) }] });
        await store.initStatusesIfMissing(id, names);
    }
    async function select(id = '101', names) {
        const meta = await store.getMeta();
        await roster(id, names);
        await store.setMeta(id, { competitionId: meta.currentCompetitionId, competitionRevision: meta.revision });
        return logic.getCurrentPayload();
    }

    test('legacy expiring keys migrate without losing check-ins', async () => {
        const id = '101';
        await redis.set(prefix + 'meta', JSON.stringify({ currentCompetitionId: id }), { ex: 86400 });
        await roster(id);
        await redis.hset(prefix + 'status:' + id, { Alice: '1' });
        await redis.expire(prefix + 'status:' + id, 86400);
        const payload = await logic.getCurrentPayload();
        assert.equal(payload.currentCompetitionId, id);
        assert.equal(payload.competitionRevision, 0);
        assert.equal(payload.groups[0].users[0].checkedIn, true);
        assert.equal(await redis.ttl(prefix + 'meta'), -1);
        assert.equal(await redis.ttl(prefix + 'status:' + id), -1);
    });

    test('SDK automatic deserialization reproduces the old string comparison bug', async () => {
        const payload = await select();
        await store.setUserStatus(context(payload), 'Alice', true);
        const defaultClient = new Redis({ url: harness.url, token: 'local-test-token', enableAutoPipelining: false });
        const fields = await defaultClient.hgetall(prefix + 'status:101');
        assert.equal(fields.Alice, 1);
        assert.equal(fields.Alice === '1', false);
        assert.equal((await logic.getCurrentPayload()).groups[0].users[0].checkedIn, true);
    });

    test('80 concurrent user writes preserve all 80 check-ins', async () => {
        const names = Array.from({ length: 80 }, (_, i) => 'Player ' + i);
        const payload = await select('101', names);
        await Promise.all(names.map(name => store.setUserStatus(context(payload), name, true)));
        assert.deepEqual((await logic.getCurrentPayload()).counts, { checkedInUsers: 80, totalUsers: 80 });
        assert.equal(await redis.ttl(prefix + 'status:101'), -1);
    });

    test('group writes change only the selected group fields', async () => {
        const payload = await select('101', ['Alice', 'Bob', 'Carol']);
        await store.setUserStatus(context(payload), 'Carol', true);
        await store.setGroupStatus(context(payload), ['Alice', 'Bob'], true);
        await store.setGroupStatus(context(payload), ['Alice', 'Bob'], false);
        const fields = (await store.getSnapshot('101')).statuses;
        assert.equal(fields.Alice, '0');
        assert.equal(fields.Bob, '0');
        assert.equal(fields.Carol, '1');
    });

    test('an old Group 1 click cannot check in Group 1 in another competition', async () => {
        const old = await select('101', ['Alice', 'Bob']);
        const current = await select('202', ['Carol', 'Dave']);
        const result = await request({ action: 'checkInGroup', groupName: 'Group 1', checkedIn: true, ...context(old) });
        assert.equal(result.statusCode, 409);
        assert.equal((await logic.getCurrentPayload()).counts.checkedInUsers, 0);
        assert.equal((await logic.getCurrentPayload()).currentCompetitionId, current.currentCompetitionId);
    });

    test('Lua rejects a competition switch occurring after handler validation', async () => {
        const old = await select('101');
        await roster('202', ['Carol', 'Dave']);
        const original = store.getRoster;
        let switched = false;
        store.getRoster = async id => {
            const result = await original(id);
            if (!switched && id === '101') { switched = true; await store.setMeta('202', context(old)); }
            return result;
        };
        try {
            const result = await request({ action: 'checkInGroup', groupName: 'Group 1', checkedIn: true, ...context(old) });
            assert.equal(result.statusCode, 409);
            assert.equal((await logic.getCurrentPayload()).counts.checkedInUsers, 0);
        } finally { store.getRoster = original; }
    });

    test('switching A to B to A still invalidates an older A click', async () => {
        const old = await select('101');
        await select('202');
        await select('101');
        await assert.rejects(store.setUserStatus(context(old), 'Alice', true), { status: 409 });
    });

    test('a refreshed roster invalidates stale group clicks', async () => {
        const old = await select();
        await roster('101', ['Carol', 'Dave']);
        const result = await request({ action: 'checkInGroup', groupName: 'Group 1', checkedIn: true, ...context(old) });
        assert.equal(result.statusCode, 409);
        assert.equal(result.body.code, 'ROSTER_CHANGED');
        assert.equal((await logic.getCurrentPayload()).counts.checkedInUsers, 0);
    });

    test('unknown players and non-boolean check-ins are rejected', async () => {
        const payload = await select();
        assert.equal((await request({ action: 'checkInUser', username: 'Unknown', checkedIn: true, ...context(payload) })).statusCode, 400);
        assert.equal((await request({ action: 'checkInUser', username: 'Alice', checkedIn: 'false', ...context(payload) })).statusCode, 400);
        assert.equal((await logic.getCurrentPayload()).counts.checkedInUsers, 0);
    });

    test('old frontend requests without competition context are rejected', async () => {
        await select();
        const result = await request({ action: 'checkInGroup', groupName: 'Group 1', checkedIn: true });
        assert.equal(result.statusCode, 400);
        assert.equal(result.body.code, 'RELOAD_REQUIRED');
    });

    test('a roster refresh preserves existing check-ins', async () => {
        const payload = await select();
        await store.setUserStatus(context(payload), 'Alice', true);
        const result = await request({ action: 'refreshFromApi', ...context(payload) });
        assert.equal(result.statusCode, 200);
        assert.equal(result.body.counts.checkedInUsers, 1);
        assert.equal(result.body.groups[0].users[0].checkedIn, true);
        assert.notEqual(result.body.rosterVersion, payload.rosterVersion);
    });

    test('roster cache expiry cannot reset the selected event or its check-ins', async () => {
        const payload = await select();
        await store.setUserStatus(context(payload), 'Alice', true);
        await redis.del(prefix + 'roster:101');
        const current = await logic.getCurrentPayload();
        assert.equal(current.currentCompetitionId, '101');
        assert.equal(current.counts.checkedInUsers, 1);
    });

    test('an older slow competition load cannot overwrite a newer switch', async () => {
        const payload = await select();
        const entered = deferred();
        const release = deferred();
        axios.get = async url => {
            const id = logic.extractCompetitionId(url);
            if (id === '202') { entered.resolve(); await release.promise; }
            return { data: { Competition: { Name: 'Event ' + id, Results: [{ Name: 'Player ' + id, Group: 1 }] } } };
        };
        const older = request({ action: 'changeApiUrl', apiUrl: '202', ...context(payload) });
        await entered.promise;
        assert.equal((await request({ action: 'changeApiUrl', apiUrl: '303', ...context(payload) })).statusCode, 200);
        release.resolve();
        assert.equal((await older).statusCode, 409);
        assert.equal((await store.getMeta()).currentCompetitionId, '303');
    });

    test('an older roster fetch cannot replace a roster already refreshed', async () => {
        await select();
        const entered = deferred();
        const release = deferred();
        let calls = 0;
        axios.get = async () => {
            calls++;
            const first = calls === 1;
            if (first) { entered.resolve(); await release.promise; }
            return { data: { Competition: { Name: first ? 'Older roster' : 'Newer roster', Results: [{ Name: first ? 'Old player' : 'New player', Group: 1 }] } } };
        };
        const oldFetch = logic.fetchPlayerData('101');
        await entered.promise;
        await logic.fetchPlayerData('101');
        release.resolve();
        await oldFetch;
        assert.equal((await store.getRoster('101')).title, 'Newer roster');
    });

    test('an atomic snapshot cannot mix the inactive event with current check-ins', async () => {
        await select('101');
        await select('202');
        assert.equal(await store.getSnapshot('101'), null);
    });

    test('Redis failure returns 503 and preserves the existing shared state', async () => {
        await select();
        harness.fail = true;
        try {
            const result = await request(undefined, 'GET');
            assert.equal(result.statusCode, 503);
            assert.equal(result.body.code, 'REDIS_UNAVAILABLE');
        } finally { harness.fail = false; }
        assert.equal((await store.getMeta()).currentCompetitionId, '101');
    });

    test('health endpoint is read-only and reports persistent keys', async () => {
        await select();
        harness.commands.length = 0;
        const res = response();
        await health({ method: 'GET' }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.storage, 'redis');
        assert.equal(res.body.ttlSeconds.selection, -1);
        assert.equal(res.body.ttlSeconds.checkIns, -1);
        assert.ok(harness.commands.every(args => ['ping', 'get', 'ttl'].includes(args[0].toLowerCase())));
    });

    test('diagnostic script verifies writes and deletes its disposable key', async () => {
        await select();
        const { stdout } = await promisify(execFile)(process.execPath, ['scripts/check-redis.js'], { cwd: path.join(__dirname, '..'), env: process.env });
        assert.equal(JSON.parse(stdout).writeAccess, 'verified');
        assert.deepEqual(await redis.keys(prefix + 'diagnostic:*'), []);
    });

    test('organizer PIN protects shared selection while allowing check-ins', async () => {
        const payload = await select();
        process.env.CHECKIN_ADMIN_PIN = 'test-organizer-pin';
        assert.equal((await request({ action: 'changeApiUrl', apiUrl: '202', ...context(payload) })).statusCode, 403);
        assert.equal((await request({ action: 'checkInUser', username: 'Alice', checkedIn: true, ...context(payload) })).statusCode, 200);
        assert.equal((await request({ action: 'changeApiUrl', apiUrl: '202', adminPin: 'test-organizer-pin', ...context(payload) })).statusCode, 200);
    });

    test('an empty valid roster does not trigger a Metrix request on every poll', async () => {
        await select('101', []);
        let calls = 0;
        axios.get = async () => { calls++; throw new Error('Should not fetch'); };
        assert.equal((await logic.getCurrentPayload()).counts.totalUsers, 0);
        assert.equal(calls, 0);
    });

    test('failed Metrix requests retain the selected event and its roster', async () => {
        const payload = await select();
        axios.get = async () => { throw new Error('Upstream offline'); };
        const result = await request({ action: 'changeApiUrl', apiUrl: '202', ...context(payload) });
        assert.equal(result.statusCode, 502);
        assert.equal((await store.getMeta()).currentCompetitionId, '101');
        assert.equal((await store.getRoster('101')).title, 'Event 101');
    });

    test('invalid JSON and unsupported methods are rejected', async () => {
        assert.equal((await request('{')).statusCode, 400);
        assert.equal((await request(undefined, 'DELETE')).statusCode, 405);
    });
});

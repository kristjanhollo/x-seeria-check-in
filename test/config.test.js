const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/stateStore');
const logic = require('../lib/competitionLogic');

function clearConfiguration() {
    store.closeRedis();
    for (const name of ['REDIS_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'CHECKIN_ALLOW_MEMORY', 'CHECKIN_REDIS_PREFIX', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV']) delete process.env[name];
}

test('missing Redis settings never use per-instance memory on Vercel', async () => {
    clearConfiguration();
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    process.env.CHECKIN_ALLOW_MEMORY = 'true';
    await assert.rejects(store.getMeta(), { code: 'REDIS_NOT_CONFIGURED', status: 503 });
});

test('local memory requires explicit opt-in', async () => {
    clearConfiguration();
    await assert.rejects(store.getMeta(), { code: 'REDIS_NOT_CONFIGURED' });
    process.env.CHECKIN_ALLOW_MEMORY = 'true';
    assert.equal((await store.getMeta()).currentCompetitionId, store.DEFAULT_COMPETITION_ID);
});

test('Vercel KV REST variable pair is accepted', () => {
    clearConfiguration();
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'test-token';
    assert.ok(store.getRedis());
});

test('REDIS_URL works with an incomplete Upstash REST configuration', () => {
    clearConfiguration();
    process.env.REDIS_URL = 'rediss://default:test-password@example.com:6379';
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    assert.ok(store.getRedis());
});

test('malformed REDIS_URL fails safely without leaking its credentials', () => {
    clearConfiguration();
    process.env.REDIS_URL = 'https://default:secret@example.com';
    assert.throws(() => store.getRedis(), error => error.code === 'REDIS_CONFIG' && !error.message.includes('secret'));
});

test('preview and production keys are isolated by default', () => {
    clearConfiguration();
    process.env.VERCEL_ENV = 'production';
    assert.equal(store.getKeyPrefix(), 'checkin:v1:');
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_REF = 'test-branch';
    assert.notEqual(store.getKeyPrefix(), 'checkin:v1:');
    assert.ok(store.getKeyPrefix().startsWith('checkin:v1:preview:'));
});

test('invalid API input cannot select an arbitrary upstream host', () => {
    assert.throws(() => logic.extractCompetitionId('https://example.com/?id=123'), { code: 'INVALID_COMPETITION_ID' });
    assert.throws(() => logic.extractCompetitionId('undefined'), { code: 'INVALID_COMPETITION_ID' });
    assert.equal(logic.extractCompetitionId('https://discgolfmetrix.com/123'), '123');
    assert.equal(logic.extractCompetitionId(logic.API_BASE_URL + '123'), '123');
});

test('duplicate player names are rejected instead of sharing a check-in', () => {
    assert.throws(() => logic.buildGroupsFromResults([{ Name: 'Alex', Group: 1 }, { Name: 'Alex', Group: 2 }]), { code: 'DUPLICATE_PLAYER_NAME' });
});

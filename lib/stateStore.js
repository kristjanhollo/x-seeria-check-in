const { createHash } = require('node:crypto');
const { AppError } = require('./errors');

const DEFAULT_COMPETITION_ID = '3529162';
let cachedClient;
let cachedConfig;

function getKeyPrefix() {
    const explicit = process.env.CHECKIN_REDIS_PREFIX;
    if (explicit) {
        if (!/^[a-zA-Z0-9:_.-]+$/.test(explicit)) {
            throw new AppError(503, 'REDIS_CONFIG', 'CHECKIN_REDIS_PREFIX has invalid characters.');
        }
        return explicit.replace(/:+$/, '') + ':';
    }
    if (process.env.VERCEL_ENV === 'production' ||
        (!process.env.VERCEL_ENV && (process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'))) return 'checkin:v1:';
    if (process.env.VERCEL_ENV === 'preview') {
        const branch = process.env.VERCEL_GIT_COMMIT_REF || process.env.VERCEL_URL || 'preview';
        const suffix = createHash('sha256').update(branch).digest('hex').slice(0, 12);
        return `checkin:v1:preview:${suffix}:`;
    }
    return 'checkin:v1:development:';
}

function keys(competitionId) {
    const prefix = getKeyPrefix();
    return {
        meta: prefix + 'meta',
        roster: prefix + 'roster:' + competitionId,
        status: prefix + 'status:' + competitionId
    };
}

// Only the external roster cache expires. The selected event and check-ins do not.
function getRosterTtlSeconds() {
    const raw = process.env.CHECKIN_ROSTER_TTL_SECONDS || process.env.CHECKIN_STATE_TTL_SECONDS;
    const n = raw ? Number(raw) : 86400;
    return Number.isSafeInteger(n) && n >= 60 ? n : 86400;
}

function getRedis() {
    const pairs = [
        [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
        [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN]
    ];
    const rest = pairs.find(([url, token]) => url && token);
    const tcpUrl = process.env.REDIS_URL;
    const config = rest ? ['rest', ...rest] : tcpUrl ? ['tcp', tcpUrl] : null;
    if (!config) {
        const explicitLocalDemo = process.env.CHECKIN_ALLOW_MEMORY === 'true' &&
            !process.env.VERCEL && !process.env.VERCEL_ENV && process.env.NODE_ENV !== 'production';
        if (explicitLocalDemo && pairs.every(([url, token]) => !url && !token)) { closeRedis(); return null; }
        throw new AppError(503, 'REDIS_NOT_CONFIGURED',
            'Redis is not configured. Set REDIS_URL, or a complete UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL / KV_REST_API_TOKEN pair, then redeploy.');
    }
    if (cachedClient && config.length === cachedConfig.length && config.every((value, i) => value === cachedConfig[i])) return cachedClient;
    closeRedis();
    if (config[0] === 'tcp') {
        const { createTcpRedis } = require('./tcpRedis');
        cachedClient = createTcpRedis(tcpUrl);
    } else {
        const { Redis } = require('@upstash/redis');
        cachedClient = new Redis({
            url: rest[0],
            token: rest[1],
            // Redis stores "1"/"0" strings; the SDK otherwise turns them into numbers.
            automaticDeserialization: false,
            enableAutoPipelining: false,
            signal: () => AbortSignal.timeout(5000),
            retry: { retries: 1, backoff: () => 100 }
        });
    }
    cachedConfig = config;
    return cachedClient;
}

function closeRedis() {
    cachedClient?.destroy?.();
    cachedClient = undefined;
    cachedConfig = undefined;
}

function memory() {
    if (!global.__checkinLocal) global.__checkinLocal = new Map();
    const prefix = getKeyPrefix();
    if (!global.__checkinLocal.has(prefix)) {
        global.__checkinLocal.set(prefix, {
            meta: { currentCompetitionId: DEFAULT_COMPETITION_ID, revision: 0 },
            rosters: new Map(),
            statuses: new Map()
        });
    }
    return global.__checkinLocal.get(prefix);
}

function parseJson(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
}

function parseMeta(raw) {
    const meta = parseJson(raw);
    const revision = meta?.revision ?? 0;
    if (!meta || !/^\d{1,20}$/.test(String(meta.currentCompetitionId || '')) ||
        !Number.isSafeInteger(revision) || revision < 0) {
        throw new AppError(503, 'INVALID_SAVED_STATE', 'The saved competition ID is invalid.');
    }
    return { ...meta, currentCompetitionId: String(meta.currentCompetitionId), revision };
}

async function redisCall(operation) {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof AppError) throw error;
        console.error('Redis operation failed:', error.name);
        throw new AppError(503, 'REDIS_UNAVAILABLE', 'Redis is unavailable. Check-ins could not be confirmed; try again.');
    }
}

const GET_META_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
    raw = ARGV[1]
    redis.call('SET', KEYS[1], raw)
else
    redis.call('PERSIST', KEYS[1])
end
return raw
`;

// Compare-and-set prevents an older, slower competition load from overwriting a newer one.
const SET_META_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'CONFLICT' end
local meta = cjson.decode(raw)
if tostring(meta.currentCompetitionId) ~= ARGV[1] or tonumber(meta.revision or 0) ~= tonumber(ARGV[2]) then
    return 'CONFLICT'
end
redis.call('SET', KEYS[1], ARGV[3])
return 'OK'
`;

const SNAPSHOT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'CONFLICT'} end
local meta = cjson.decode(raw)
if tostring(meta.currentCompetitionId) ~= ARGV[1] then return {'CONFLICT'} end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[3])
return {'OK', raw, redis.call('GET', KEYS[2]) or false, redis.call('HGETALL', KEYS[3])}
`;

// The event/version check and all group fields are part of ONE Redis operation.
const SET_STATUS_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'CONFLICT' end
local meta = cjson.decode(raw)
if tostring(meta.currentCompetitionId) ~= ARGV[1] or tonumber(meta.revision or 0) ~= tonumber(ARGV[2]) then
    return 'CONFLICT'
end
local rosterRaw = redis.call('GET', KEYS[2])
if not rosterRaw then return 'STALE_ROSTER' end
local roster = cjson.decode(rosterRaw)
if (roster.version or roster.lastUpdated) ~= ARGV[3] then return 'STALE_ROSTER' end
for i = 5, #ARGV do
    redis.call('HSET', KEYS[3], ARGV[i], ARGV[4])
end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[3])
return 'OK'
`;

const INIT_STATUS_SCRIPT = `
for i = 1, #ARGV do
    redis.call('HSETNX', KEYS[1], ARGV[i], '0')
end
redis.call('PERSIST', KEYS[1])
return 'OK'
`;

const SET_ROSTER_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then
    local roster = cjson.decode(raw)
    if (roster.version or roster.lastUpdated or '') ~= ARGV[1] then return 'STALE' end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 'OK'
`;

function conflict(code = 'COMPETITION_CHANGED') {
    return new AppError(409, code, code === 'ROSTER_CHANGED'
        ? 'The player groups changed. Reload the list before checking in.'
        : 'The competition changed on another device. Reload the list before checking in.');
}

function assertCurrent(meta, expected) {
    if (meta.currentCompetitionId !== expected.competitionId || (meta.revision || 0) !== expected.competitionRevision) {
        throw conflict();
    }
}

async function getMeta() {
    const redis = getRedis();
    if (!redis) return { ...memory().meta };
    return redisCall(async () => parseMeta(await redis.eval(GET_META_SCRIPT, [keys().meta], [
        JSON.stringify({ currentCompetitionId: DEFAULT_COMPETITION_ID, revision: 0 })
    ])));
}

async function setMeta(competitionId, expected) {
    const meta = { currentCompetitionId: competitionId, revision: expected.competitionRevision + 1, changedAt: new Date().toISOString() };
    const redis = getRedis();
    if (!redis) {
        assertCurrent(memory().meta, expected);
        memory().meta = meta;
        return meta;
    }
    const result = await redisCall(() => redis.eval(SET_META_SCRIPT, [keys().meta], [
        expected.competitionId, String(expected.competitionRevision), JSON.stringify(meta)
    ]));
    if (result !== 'OK') throw conflict();
    return meta;
}

async function getRoster(competitionId) {
    const redis = getRedis();
    if (!redis) return memory().rosters.get(competitionId) || null;
    return redisCall(async () => parseJson(await redis.get(keys(competitionId).roster)));
}

async function setRoster(competitionId, roster, previousVersion) {
    const redis = getRedis();
    if (!redis) {
        const previous = memory().rosters.get(competitionId);
        if (previousVersion !== undefined && previous && (previous.version || previous.lastUpdated || '') !== previousVersion) return false;
        memory().rosters.set(competitionId, roster);
        return true;
    }
    if (previousVersion !== undefined) {
        const result = await redisCall(() => redis.eval(SET_ROSTER_SCRIPT, [keys(competitionId).roster], [
            previousVersion, JSON.stringify(roster), String(getRosterTtlSeconds())
        ]));
        return result === 'OK';
    }
    await redisCall(() => redis.set(keys(competitionId).roster, JSON.stringify(roster), { ex: getRosterTtlSeconds() }));
    return true;
}

async function getSnapshot(competitionId) {
    const redis = getRedis();
    if (!redis) {
        const data = memory();
        if (data.meta.currentCompetitionId !== competitionId) return null;
        return { meta: { ...data.meta }, roster: data.rosters.get(competitionId) || null, statuses: { ...(data.statuses.get(competitionId) || {}) } };
    }
    const k = keys(competitionId);
    const result = await redisCall(() => redis.eval(SNAPSHOT_SCRIPT, [k.meta, k.roster, k.status], [competitionId]));
    if (result[0] !== 'OK') return null;
    const fields = result[3] || [];
    const statuses = Object.create(null);
    for (let i = 0; i < fields.length; i += 2) statuses[fields[i]] = fields[i + 1];
    return { meta: parseMeta(result[1]), roster: parseJson(result[2]), statuses };
}

async function setGroupStatus(expected, usernames, checkedIn) {
    const value = checkedIn ? '1' : '0';
    const redis = getRedis();
    if (!redis) {
        const data = memory();
        assertCurrent(data.meta, expected);
        const roster = data.rosters.get(expected.competitionId);
        if ((roster?.version || roster?.lastUpdated) !== expected.rosterVersion) throw conflict('ROSTER_CHANGED');
        const statuses = data.statuses.get(expected.competitionId) || Object.create(null);
        for (const username of usernames) statuses[username] = value;
        data.statuses.set(expected.competitionId, statuses);
        return;
    }
    const k = keys(expected.competitionId);
    const result = await redisCall(() => redis.eval(SET_STATUS_SCRIPT, [k.meta, k.roster, k.status], [
        expected.competitionId, String(expected.competitionRevision), expected.rosterVersion, value, ...usernames
    ]));
    if (result === 'CONFLICT') throw conflict();
    if (result === 'STALE_ROSTER') throw conflict('ROSTER_CHANGED');
    if (result !== 'OK') throw new AppError(503, 'REDIS_UNAVAILABLE', 'The check-in could not be confirmed.');
}

async function setUserStatus(expected, username, checkedIn) {
    return setGroupStatus(expected, [username], checkedIn);
}

async function initStatusesIfMissing(competitionId, usernames) {
    const redis = getRedis();
    if (!redis) {
        const data = memory();
        const statuses = data.statuses.get(competitionId) || Object.create(null);
        for (const username of usernames) if (statuses[username] === undefined) statuses[username] = '0';
        data.statuses.set(competitionId, statuses);
        return;
    }
    await redisCall(() => redis.eval(INIT_STATUS_SCRIPT, [keys(competitionId).status], usernames));
}

// Read-only diagnostics: never switches the competition or changes a check-in.
async function probeStorage() {
    const redis = getRedis();
    if (!redis) return { ok: true, storage: 'memory', durable: false, environment: 'local', namespace: getKeyPrefix() };
    return redisCall(async () => {
        const pipeline = redis.pipeline();
        pipeline.ping();
        pipeline.get(keys().meta);
        pipeline.ttl(keys().meta);
        const [pong, raw, selectionTtl] = await pipeline.exec();
        const meta = raw ? parseMeta(raw) : null;
        let rosterTtl = -2;
        let checkInsTtl = -2;
        if (meta) {
            const k = keys(meta.currentCompetitionId);
            const ttls = redis.pipeline();
            ttls.ttl(k.roster);
            ttls.ttl(k.status);
            [rosterTtl, checkInsTtl] = await ttls.exec();
        }
        return {
            ok: pong === 'PONG', storage: 'redis', connection: cachedConfig[0], durable: true,
            environment: process.env.VERCEL_ENV || 'local', namespace: getKeyPrefix(),
            currentCompetitionId: meta?.currentCompetitionId || null,
            ttlSeconds: { selection: selectionTtl, roster: rosterTtl, checkIns: checkInsTtl },
            writeAccess: 'not-tested'
        };
    });
}

module.exports = {
    DEFAULT_COMPETITION_ID, getKeyPrefix, getRedis, closeRedis, getMeta, setMeta,
    getRoster, setRoster, getSnapshot, setUserStatus, setGroupStatus,
    initStatusesIfMissing, probeStorage, conflict
};

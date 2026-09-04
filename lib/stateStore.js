const ROSTER_PREFIX = 'checkin:v1:roster:';
const STATUS_PREFIX = 'checkin:v1:status:';
const META_KEY = 'checkin:v1:meta';
const DEFAULT_COMPETITION_ID = '3529162';

/** Seconds until stored state expires (Redis EX). Default 24h — sliding window on each save. */
function getTtlSeconds() {
    const raw = process.env.CHECKIN_STATE_TTL_SECONDS;
    const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 86400;
    if (!Number.isFinite(n) || n < 60) {
        return 86400;
    }
    return n;
}

function getRedis() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    const { Redis } = require('@upstash/redis');
    return new Redis({ url, token });
}

// ---- in-memory fallback (single instance / local dev without Redis env vars) ----
function memory() {
    if (!global.__checkin) {
        global.__checkin = {
            meta: { currentCompetitionId: DEFAULT_COMPETITION_ID },
            rosters: {}, // competitionId -> { title, groups: [{groupName, users:[{username}]}], lastUpdated }
            statuses: {} // competitionId -> { username: '1' | '0' }
        };
    }
    return global.__checkin;
}

// ---- meta (which competition is "current") ----
async function getMeta() {
    const redis = getRedis();
    if (redis) {
        const data = await redis.get(META_KEY);
        if (!data) return { currentCompetitionId: DEFAULT_COMPETITION_ID };
        return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return memory().meta;
}

async function setMeta(meta) {
    const redis = getRedis();
    if (redis) {
        await redis.set(META_KEY, JSON.stringify(meta), { ex: getTtlSeconds() });
        return;
    }
    memory().meta = meta;
}

// ---- roster (players/groups for a competition — written rarely, on API refresh) ----
async function getRoster(competitionId) {
    const redis = getRedis();
    if (redis) {
        const data = await redis.get(ROSTER_PREFIX + competitionId);
        if (!data) return null;
        return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return memory().rosters[competitionId] || null;
}

async function setRoster(competitionId, roster) {
    const redis = getRedis();
    if (redis) {
        await redis.set(ROSTER_PREFIX + competitionId, JSON.stringify(roster), {
            ex: getTtlSeconds()
        });
        return;
    }
    memory().rosters[competitionId] = roster;
}

// ---- check-in status (written constantly, by many people at once — must be atomic per user) ----
async function getStatuses(competitionId) {
    const redis = getRedis();
    if (redis) {
        const data = await redis.hgetall(STATUS_PREFIX + competitionId);
        return data || {};
    }
    return memory().statuses[competitionId] || {};
}

/** Flip a single user's check-in status. Atomic — never touches anyone else's data. */
async function setUserStatus(competitionId, username, checkedIn) {
    const value = checkedIn ? '1' : '0';
    const redis = getRedis();
    if (redis) {
        await redis.hset(STATUS_PREFIX + competitionId, { [username]: value });
        await redis.expire(STATUS_PREFIX + competitionId, getTtlSeconds());
        return;
    }
    const statuses = memory().statuses;
    statuses[competitionId] = statuses[competitionId] || {};
    statuses[competitionId][username] = value;
}

/** Flip every user in a list (e.g. a whole group) in one atomic multi-field write. */
async function setGroupStatus(competitionId, usernames, checkedIn) {
    if (!usernames || usernames.length === 0) return;
    const value = checkedIn ? '1' : '0';
    const redis = getRedis();
    if (redis) {
        const fields = {};
        usernames.forEach((u) => {
            fields[u] = value;
        });
        await redis.hset(STATUS_PREFIX + competitionId, fields);
        await redis.expire(STATUS_PREFIX + competitionId, getTtlSeconds());
        return;
    }
    const statuses = memory().statuses;
    statuses[competitionId] = statuses[competitionId] || {};
    usernames.forEach((u) => {
        statuses[competitionId][u] = value;
    });
}

/**
 * Seed status entries for newly-seen players without clobbering anyone who
 * already checked in (uses HSETNX so an existing '1' is never overwritten).
 */
async function initStatusesIfMissing(competitionId, usernames) {
    const redis = getRedis();
    if (redis) {
        await Promise.all(
            usernames.map((u) => redis.hsetnx(STATUS_PREFIX + competitionId, u, '0'))
        );
        await redis.expire(STATUS_PREFIX + competitionId, getTtlSeconds());
        return;
    }
    const statuses = memory().statuses;
    statuses[competitionId] = statuses[competitionId] || {};
    usernames.forEach((u) => {
        if (statuses[competitionId][u] === undefined) {
            statuses[competitionId][u] = '0';
        }
    });
}

module.exports = {
    DEFAULT_COMPETITION_ID,
    getMeta,
    setMeta,
    getRoster,
    setRoster,
    getStatuses,
    setUserStatus,
    setGroupStatus,
    initStatusesIfMissing
};

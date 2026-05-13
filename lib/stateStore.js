const KV_KEY = 'checkin:v1';

/** Seconds until stored state expires (Redis EX). Default 24h — sliding window on each save. */
function getTtlSeconds() {
    const raw = process.env.CHECKIN_STATE_TTL_SECONDS;
    const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 86400;
    if (!Number.isFinite(n) || n < 60) {
        return 86400;
    }
    return n;
}

function emptyState() {
    return {
        competitionsData: {},
        currentCompetitionId: '3203240'
    };
}

function getRedis() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    const { Redis } = require('@upstash/redis');
    return new Redis({ url, token });
}

async function getState() {
    const redis = getRedis();
    if (redis) {
        const data = await redis.get(KV_KEY);
        if (!data) return emptyState();
        if (typeof data === 'string') {
            return JSON.parse(data);
        }
        return data;
    }
    const expiresAt = global.__checkinStateExpiresAt;
    if (expiresAt && Date.now() > expiresAt) {
        global.__checkinState = null;
        global.__checkinStateExpiresAt = null;
    }
    if (!global.__checkinState) {
        global.__checkinState = emptyState();
    }
    return global.__checkinState;
}

async function setState(state) {
    const ttl = getTtlSeconds();
    const redis = getRedis();
    if (redis) {
        await redis.set(KV_KEY, JSON.stringify(state), { ex: ttl });
        return;
    }
    global.__checkinState = state;
    global.__checkinStateExpiresAt = Date.now() + ttl * 1000;
}

module.exports = { getState, setState, emptyState };

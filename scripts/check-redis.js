// Loads variables using Node's --env-file when needed:
// node --env-file=.env.local scripts/check-redis.js
// Writes one disposable probe key, never the selected event or its check-ins.
const { randomUUID } = require('node:crypto');
const store = require('../lib/stateStore');

async function main() {
    const redis = store.getRedis();
    if (!redis) throw new Error('This check requires Redis credentials, not local memory mode.');
    const key = store.getKeyPrefix() + 'diagnostic:' + randomUUID();
    const value = randomUUID();
    let created = false;
    try {
        const report = await store.probeStorage();
        await redis.set(key, value, { ex: 60 });
        created = true;
        const found = await redis.get(key);
        if (found !== value) throw new Error('Redis write/read verification failed.');
        console.log(JSON.stringify({ ...report, writeAccess: 'verified', readBack: 'verified' }, null, 2));
    } finally {
        if (created) await redis.del(key);
    }
}

main().catch(error => {
    console.error(error.code || 'REDIS_CHECK_FAILED');
    console.error('Redis write/read verification failed. Check credentials, permissions and connectivity.');
    process.exitCode = 1;
}).finally(() => store.closeRedis());

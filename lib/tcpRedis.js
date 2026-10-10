const { createClient } = require('redis');
const { AppError } = require('./errors');

// Same commands/reply shapes as the REST client, backed by a shared TCP socket.
function createTcpRedis(url) {
    try {
        const parsed = new URL(url);
        if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch {
        throw new AppError(503, 'REDIS_CONFIG', 'REDIS_URL must be a redis:// or rediss:// connection string.');
    }
    let client;
    try {
        client = createClient({
            url,
            disableOfflineQueue: true,
            commandsQueueMaxLength: 2048,
            commandOptions: { timeout: 5000 },
            socket: { connectTimeout: 5000, socketTimeout: 10000, reconnectStrategy: false }
        });
    } catch {
        throw new AppError(503, 'REDIS_CONFIG', 'REDIS_URL is not a valid Redis connection string.');
    }
    // Socket errors also reject commands. Never log the URL/password from an event.
    client.on('error', () => {});
    let connecting;
    async function ready() {
        if (client.isReady) return client;
        if (!connecting) connecting = client.connect().finally(() => { connecting = undefined; });
        await connecting;
        return client;
    }
    async function command(...args) {
        await ready();
        return client.sendCommand(args.map(String));
    }
    return {
        get: key => command('GET', key),
        set: (key, value, options = {}) => command('SET', key, value, ...(options.ex ? ['EX', options.ex] : [])),
        del: (...keys) => command('DEL', ...keys),
        ttl: key => command('TTL', key),
        expire: (key, seconds) => command('EXPIRE', key, seconds),
        keys: pattern => command('KEYS', pattern),
        hset: (key, fields) => command('HSET', key, ...Object.entries(fields).flat()),
        eval: (script, keys, args) => command('EVAL', script, keys.length, ...keys, ...args),
        pipeline() {
            const commands = [];
            const pipeline = {
                ping() { commands.push(['PING']); return pipeline; },
                get(key) { commands.push(['GET', key]); return pipeline; },
                ttl(key) { commands.push(['TTL', key]); return pipeline; },
                // These are independent diagnostic reads; mutations use atomic Lua.
                exec: () => Promise.all(commands.map(args => command(...args)))
            };
            return pipeline;
        },
        destroy() { if (client.isOpen) client.destroy(); }
    };
}

module.exports = { createTcpRedis };

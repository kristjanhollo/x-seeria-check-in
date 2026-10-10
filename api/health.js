const store = require('../lib/stateStore');
const { AppError } = require('../lib/errors');

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
        const report = await store.probeStorage();
        return res.status(report.ok ? 200 : 503).json(report);
    } catch (error) {
        return res.status(503).json({
            ok: false, storage: 'redis',
            code: error instanceof AppError ? error.code : 'REDIS_UNAVAILABLE',
            error: error instanceof AppError ? error.message : 'Redis health check failed.'
        });
    }
};

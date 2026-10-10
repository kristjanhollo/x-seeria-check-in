const { createHash, timingSafeEqual } = require('node:crypto');
const logic = require('../lib/competitionLogic');
const store = require('../lib/stateStore');
const { AppError } = require('../lib/errors');

function readBody(req) {
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
        return body;
    } catch (_) {
        throw new AppError(400, 'INVALID_BODY', 'Send a JSON object.');
    }
}

function requireContext(body, requireRoster = false) {
    if (typeof body.competitionId !== 'string' || !/^\d{1,20}$/.test(body.competitionId) ||
        !Number.isSafeInteger(body.competitionRevision) || body.competitionRevision < 0 ||
        (requireRoster && (typeof body.rosterVersion !== 'string' || !body.rosterVersion))) {
        throw new AppError(400, 'RELOAD_REQUIRED', 'Reload this page before making changes. The competition context is missing.');
    }
    return {
        competitionId: body.competitionId,
        competitionRevision: body.competitionRevision,
        rosterVersion: body.rosterVersion
    };
}

function requireOrganizer(body) {
    const pin = process.env.CHECKIN_ADMIN_PIN;
    if (!pin) return;
    const supplied = typeof body.adminPin === 'string' ? body.adminPin : '';
    const hash = value => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(hash(pin), hash(supplied))) {
        throw new AppError(403, 'ORGANIZER_PIN_REQUIRED', 'Enter the organizer PIN to change or refresh the competition.');
    }
}

function assertContext(meta, expected) {
    if (meta.currentCompetitionId !== expected.competitionId || meta.revision !== expected.competitionRevision) throw store.conflict();
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
        if (req.method === 'GET') return res.status(200).json({ ...await logic.getCurrentPayload(), notice: null });

        const body = readBody(req);
        const allowed = ['checkInUser', 'checkInGroup', 'changeApiUrl', 'refreshFromApi'];
        if (!allowed.includes(body.action)) throw new AppError(400, 'UNKNOWN_ACTION', 'Unknown action.');
        if (body.action === 'changeApiUrl' || body.action === 'refreshFromApi') requireOrganizer(body);
        const meta = await store.getMeta();
        let notice = null;
        switch (body.action) {
            case 'checkInUser':
            case 'checkInGroup': {
                const expected = requireContext(body, true);
                assertContext(meta, expected);
                if (typeof body.checkedIn !== 'boolean') throw new AppError(400, 'INVALID_STATUS', 'checkedIn must be true or false.');
                const roster = await store.getRoster(expected.competitionId);
                if (!roster || (roster.version || roster.lastUpdated) !== expected.rosterVersion) throw store.conflict('ROSTER_CHANGED');
                if (body.action === 'checkInUser') {
                    if (typeof body.username !== 'string' || !roster.groups.some(group => group.users.some(user => user.username === body.username))) {
                        throw new AppError(400, 'UNKNOWN_PLAYER', 'This player is not in the displayed competition.');
                    }
                    await store.setUserStatus(expected, body.username, body.checkedIn);
                } else {
                    const group = roster.groups.find(candidate => candidate.groupName === body.groupName);
                    if (!group) throw new AppError(400, 'UNKNOWN_GROUP', 'This group is not in the displayed competition.');
                    await store.setGroupStatus(expected, group.users.map(user => user.username), body.checkedIn);
                }
                break;
            }
            case 'changeApiUrl': {
                // Allow first-time setup even if the old/default roster cannot load.
                const expected = body.competitionId == null
                    ? { competitionId: meta.currentCompetitionId, competitionRevision: meta.revision }
                    : requireContext(body);
                assertContext(meta, expected);
                const result = await logic.fetchPlayerData(body.apiUrl);
                await store.setMeta(result.competitionId, expected);
                notice = { type: 'success', text: 'Competition loaded for all devices.' };
                break;
            }
            case 'refreshFromApi': {
                const expected = requireContext(body);
                assertContext(meta, expected);
                await logic.fetchPlayerData(expected.competitionId);
                notice = { type: 'success', text: 'Player list refreshed. Existing check-ins were preserved.' };
                break;
            }
        }
        // Always respond with the currently selected event, even if another device switched meanwhile.
        return res.status(200).json({ ...await logic.getCurrentPayload(), notice });
    } catch (error) {
        console.error('Competition request failed:', error.code || error.name);
        const known = error instanceof AppError;
        return res.status(known ? error.status : 500).json({
            code: known ? error.code : 'SERVER_ERROR',
            error: known ? error.message : 'Server error. The change could not be confirmed.'
        });
    }
};

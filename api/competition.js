const logic = require('../lib/competitionLogic');
const store = require('../lib/stateStore');

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
        const meta = await store.getMeta();
        let competitionId = logic.normalizeStoredCompetitionId(meta);
        await logic.ensureInitialized(competitionId);

        if (req.method === 'GET') {
            const payload = await logic.toClientPayload(competitionId);
            return res.status(200).json({ ...payload, notice: null });
        }

        if (req.method === 'POST') {
            const body =
                typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
            const { action, ...rest } = body;
            let notice = null;

            switch (action) {
                case 'checkInUser': {
                    // Atomic single-field write — safe even if many people check in at once.
                    await store.setUserStatus(competitionId, rest.username, rest.checkedIn);
                    break;
                }
                case 'checkInGroup': {
                    const roster = await store.getRoster(competitionId);
                    const group =
                        roster && roster.groups.find((g) => g.groupName === rest.groupName);
                    const usernames = group ? group.users.map((u) => u.username) : [];
                    await store.setGroupStatus(competitionId, usernames, rest.checkedIn);
                    break;
                }
                case 'changeApiUrl': {
                    const result = await logic.fetchPlayerData(rest.apiUrl);
                    if (result.error) {
                        notice = { type: 'error', text: result.error };
                    } else {
                        competitionId = result.competitionId;
                        await store.setMeta({ currentCompetitionId: competitionId });
                        notice = { type: 'success', text: 'API data loaded successfully' };
                    }
                    break;
                }
                case 'refreshFromApi': {
                    const apiUrl = logic.API_BASE_URL + competitionId;
                    const result = await logic.fetchPlayerData(apiUrl);
                    if (result.error) {
                        notice = { type: 'error', text: result.error };
                    } else {
                        notice = { type: 'success', text: 'API data refreshed successfully' };
                    }
                    break;
                }
                default:
                    return res.status(400).json({ error: 'Unknown action' });
            }

            const payload = await logic.toClientPayload(competitionId);
            return res.status(200).json({ ...payload, notice });
        }

        res.setHeader('Allow', ['GET', 'POST']);
        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || 'Server error' });
    }
};

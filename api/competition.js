const logic = require('../lib/competitionLogic');
const store = require('../lib/stateStore');

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
        let state = await store.getState();
        state = await logic.ensureInitialized(state);

        if (req.method === 'GET') {
            await store.setState(state);
            return res.status(200).json({
                ...logic.toClientPayload(state),
                notice: null
            });
        }

        if (req.method === 'POST') {
            const body =
                typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
            const { action, ...rest } = body;
            let notice = null;

            switch (action) {
                case 'checkInUser': {
                    state = logic.updateUserCheckInStatus(
                        state,
                        rest.username,
                        rest.checkedIn
                    );
                    break;
                }
                case 'checkInGroup': {
                    state = logic.updateGroupCheckInStatus(
                        state,
                        rest.groupName,
                        rest.checkedIn
                    );
                    break;
                }
                case 'changeApiUrl': {
                    const result = await logic.fetchPlayerData(state, rest.apiUrl);
                    state = result.state;
                    if (result.error) {
                        notice = { type: 'error', text: result.error };
                    } else {
                        notice = { type: 'success', text: 'API data loaded successfully' };
                    }
                    break;
                }
                case 'refreshFromApi': {
                    const apiUrl = logic.API_BASE_URL + state.currentCompetitionId;
                    const result = await logic.fetchPlayerData(state, apiUrl);
                    state = result.state;
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

            await store.setState(state);
            return res.status(200).json({
                ...logic.toClientPayload(state),
                notice
            });
        }

        res.setHeader('Allow', ['GET', 'POST']);
        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message || 'Server error' });
    }
};

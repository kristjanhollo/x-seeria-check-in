const axios = require('axios');
const { randomUUID } = require('node:crypto');
const store = require('./stateStore');
const { AppError } = require('./errors');

const API_BASE_URL = 'https://discgolfmetrix.com/api.php?content=result&id=';

function extractCompetitionId(input) {
    const value = String(input || '').trim();
    if (/^\d{1,20}$/.test(value)) return value;
    try {
        const url = new URL(value);
        if (!['discgolfmetrix.com', 'www.discgolfmetrix.com'].includes(url.hostname) ||
            !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid host');
        const id = url.searchParams.get('id') || url.pathname.replace(/^\/+|\/+$/g, '');
        if (/^\d{1,20}$/.test(id)) return id;
    } catch (_) {
        // Return a useful validation error instead of treating arbitrary text as an ID.
    }
    throw new AppError(400, 'INVALID_COMPETITION_ID', 'Enter a numeric competition ID or a Disc Golf Metrix competition URL.');
}

function ensureApiUrl(input) {
    return API_BASE_URL + extractCompetitionId(input);
}

function buildGroupsFromResults(results) {
    if (!Array.isArray(results)) throw new AppError(502, 'INVALID_ROSTER', 'Metrix returned an invalid player list.');
    const groupMap = new Map();
    const names = new Set();
    for (const player of results) {
        const username = player?.Name;
        if (typeof username !== 'string' || !username.trim()) {
            throw new AppError(502, 'INVALID_ROSTER', 'Metrix returned a player without a name.');
        }
        // Existing Redis data uses exact names as identities. Never silently merge two players.
        if (names.has(username)) {
            throw new AppError(502, 'DUPLICATE_PLAYER_NAME', 'Two players have the same name in Metrix. Give them distinct names before loading this competition.');
        }
        names.add(username);
        const groupNumber = player.Group == null || player.Group === '' ? 'Ungrouped' : String(player.Group);
        if (!groupMap.has(groupNumber)) groupMap.set(groupNumber, []);
        groupMap.get(groupNumber).push({ username });
    }
    return [...groupMap].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([number, users]) => ({ groupName: number === 'Ungrouped' ? 'Ungrouped' : `Group ${number}`, users }));
}

async function fetchPlayerData(input) {
    const competitionId = extractCompetitionId(input);
    const previous = await store.getRoster(competitionId);
    let response;
    try {
        response = await axios.get(API_BASE_URL + competitionId, { timeout: 10000, maxRedirects: 0 });
    } catch (_) {
        throw new AppError(502, 'METRIX_UNAVAILABLE', 'Could not load the player list from Metrix. The selected competition has not been changed.');
    }
    const competition = response.data?.Competition;
    if (!competition) throw new AppError(502, 'INVALID_ROSTER', 'Metrix did not return a competition.');
    const groups = buildGroupsFromResults(competition.Results);
    // Validate everything before overwriting the previous cached roster.
    const saved = await store.setRoster(competitionId, {
        title: String(competition.Name || 'Check-In System'),
        groups,
        lastUpdated: new Date().toISOString(),
        version: randomUUID()
    }, previous?.version || previous?.lastUpdated || '');
    // One Lua script, rather than one HTTP request for every player.
    // HSETNX preserves all existing check-ins when a roster is refreshed.
    if (saved) await store.initStatusesIfMissing(competitionId, groups.flatMap(group => group.users.map(user => user.username)));
    return { competitionId };
}

async function ensureInitialized(competitionId) {
    const roster = await store.getRoster(competitionId);
    if (roster && Array.isArray(roster.groups)) return;
    await fetchPlayerData(competitionId);
}

function calculateCheckedInCounts(groups) {
    return groups.reduce((counts, group) => ({
        totalUsers: counts.totalUsers + group.users.length,
        checkedInUsers: counts.checkedInUsers + group.users.filter(user => user.checkedIn).length
    }), { totalUsers: 0, checkedInUsers: 0 });
}

async function toClientPayload(competitionId) {
    const snapshot = await store.getSnapshot(competitionId);
    if (!snapshot) throw store.conflict();
    if (!snapshot.roster) throw store.conflict('ROSTER_CHANGED');
    const groups = snapshot.roster.groups.map(group => ({
        groupName: group.groupName,
        users: group.users.map(user => ({
            username: user.username,
            checkedIn: snapshot.statuses[user.username] === '1' || snapshot.statuses[user.username] === 1 || snapshot.statuses[user.username] === true
        }))
    }));
    return {
        groups, title: snapshot.roster.title,
        currentCompetitionId: snapshot.meta.currentCompetitionId,
        competitionRevision: snapshot.meta.revision,
        rosterVersion: snapshot.roster.version || snapshot.roster.lastUpdated,
        currentApiUrl: API_BASE_URL + competitionId,
        counts: calculateCheckedInCounts(groups),
        adminPinRequired: Boolean(process.env.CHECKIN_ADMIN_PIN)
    };
}

async function getCurrentPayload() {
    // Another organizer may switch competitions while the external roster is loading.
    for (let attempt = 0; attempt < 3; attempt++) {
        const meta = await store.getMeta();
        await ensureInitialized(meta.currentCompetitionId);
        try {
            return await toClientPayload(meta.currentCompetitionId);
        } catch (error) {
            if (error.code !== 'COMPETITION_CHANGED' && error.code !== 'ROSTER_CHANGED') throw error;
        }
    }
    throw store.conflict();
}

module.exports = {
    API_BASE_URL, extractCompetitionId, ensureApiUrl, buildGroupsFromResults,
    fetchPlayerData, calculateCheckedInCounts, ensureInitialized, toClientPayload, getCurrentPayload
};

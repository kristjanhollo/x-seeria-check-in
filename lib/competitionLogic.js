const axios = require('axios');
const store = require('./stateStore');

const API_BASE_URL = 'https://discgolfmetrix.com/api.php?content=result&id=';
const DEFAULT_ID = store.DEFAULT_COMPETITION_ID;

function extractCompetitionId(url) {
    if (/^\d+$/.test(url)) {
        return url;
    }
    const idMatch = url.match(/id=(\d+)/);
    return idMatch && idMatch[1] ? idMatch[1] : url;
}

function ensureApiUrl(url) {
    if (/^\d+$/.test(url)) {
        return API_BASE_URL + url;
    }
    if (!url.startsWith(API_BASE_URL)) {
        const idMatch = url.match(/id=(\d+)/);
        if (idMatch && idMatch[1]) {
            return API_BASE_URL + idMatch[1];
        }
        return API_BASE_URL + url;
    }
    return url;
}

function normalizeStoredCompetitionId(meta) {
    const raw = meta && meta.currentCompetitionId;
    if (raw == null || String(raw).trim() === '') {
        return DEFAULT_ID;
    }
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) {
        return s;
    }
    const fromUrl = extractCompetitionId(s);
    return /^\d+$/.test(fromUrl) ? fromUrl : DEFAULT_ID;
}

const buildGroupsFromResults = (results) => {
    const groupMap = {};
    results.forEach((player) => {
        const groupNumber = player.Group;
        const username = player.Name;
        if (!groupMap[groupNumber]) {
            groupMap[groupNumber] = [];
        }
        groupMap[groupNumber].push({ username });
    });
    return Object.keys(groupMap).map((groupNumber) => ({
        groupName: `Group ${groupNumber}`,
        users: groupMap[groupNumber]
    }));
};

/**
 * Fetch the roster (players/groups, no check-in state) from the external API,
 * store it, and seed check-in status for any new players — without ever
 * touching the status of players who already checked in.
 */
async function fetchPlayerData(apiUrl) {
    try {
        const normalizedUrl = ensureApiUrl(apiUrl);
        const competitionId = extractCompetitionId(normalizedUrl);

        const response = await axios.get(normalizedUrl);
        const competitionTitle = response.data.Competition.Name || 'Check-In System';
        const results = response.data.Competition.Results;
        const groups = buildGroupsFromResults(results);

        await store.setRoster(competitionId, {
            title: competitionTitle,
            groups,
            lastUpdated: new Date().toISOString()
        });

        const allUsernames = groups.flatMap((g) => g.users.map((u) => u.username));
        await store.initStatusesIfMissing(competitionId, allUsernames);

        return { competitionId };
    } catch (error) {
        console.error('Error fetching player data:', error.message);
        return { error: 'Failed to fetch data from API' };
    }
}

function calculateCheckedInCounts(groups) {
    let totalUsers = 0;
    let checkedInUsers = 0;
    groups.forEach((group) => {
        totalUsers += group.users.length;
        checkedInUsers += group.users.filter((user) => user.checkedIn).length;
    });
    return { totalUsers, checkedInUsers };
}

/** Merge the (rarely-changing) roster with the (constantly-changing) status hash. */
async function toClientPayload(competitionId) {
    const roster = await store.getRoster(competitionId);
    const statuses = await store.getStatuses(competitionId);

    const rosterData = roster || { title: 'Loading...', groups: [], lastUpdated: null };
    const groups = rosterData.groups.map((group) => ({
        groupName: group.groupName,
        users: group.users.map((user) => ({
            username: user.username,
            checkedIn: statuses[user.username] === '1'
        }))
    }));

    return {
        groups,
        title: rosterData.title,
        currentCompetitionId: competitionId,
        currentApiUrl: API_BASE_URL + competitionId,
        counts: calculateCheckedInCounts(groups)
    };
}

async function ensureInitialized(competitionId) {
    const roster = await store.getRoster(competitionId);
    if (roster && roster.groups && roster.groups.length > 0) {
        return;
    }
    await fetchPlayerData(API_BASE_URL + competitionId);
}

module.exports = {
    API_BASE_URL,
    DEFAULT_ID,
    extractCompetitionId,
    ensureApiUrl,
    fetchPlayerData,
    calculateCheckedInCounts,
    ensureInitialized,
    normalizeStoredCompetitionId,
    toClientPayload
};

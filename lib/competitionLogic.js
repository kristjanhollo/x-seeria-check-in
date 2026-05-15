const axios = require('axios');

const API_BASE_URL = 'https://discgolfmetrix.com/api.php?content=result&id=';
const DEFAULT_ID = '3203240';

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

function getCurrentCompetition(state) {
    return state.competitionsData[state.currentCompetitionId] || {
        title: 'Loading...',
        groups: [],
        lastUpdated: null
    };
}

const processPlayerGroupsWithCheckIn = (competitionId, results, competitionsData) => {
    const existingData = competitionsData[competitionId] || {
        title: 'Unknown Competition',
        groups: [],
        lastUpdated: null
    };

    const groupMap = {};
    const existingUsers = {};

    if (existingData.groups && existingData.groups.length > 0) {
        existingData.groups.forEach((group) => {
            group.users.forEach((user) => {
                existingUsers[user.username] = user.checkedIn;
            });
        });
    }

    results.forEach((player) => {
        const groupNumber = player.Group;
        const username = player.Name;

        if (!groupMap[groupNumber]) {
            groupMap[groupNumber] = [];
        }

        groupMap[groupNumber].push({
            username,
            checkedIn:
                existingUsers[username] !== undefined ? existingUsers[username] : false
        });
    });

    const newGroups = Object.keys(groupMap).map((groupNumber) => ({
        groupName: `Group ${groupNumber}`,
        users: groupMap[groupNumber]
    }));

    return newGroups;
};

async function fetchPlayerData(state, apiUrl) {
    try {
        const normalizedUrl = ensureApiUrl(apiUrl);
        const competitionId = extractCompetitionId(normalizedUrl);

        const response = await axios.get(normalizedUrl);
        const competitionTitle = response.data.Competition.Name || 'Check-In System';
        const results = response.data.Competition.Results;
        const newGroups = processPlayerGroupsWithCheckIn(
            competitionId,
            results,
            state.competitionsData
        );

        const next = {
            ...state,
            competitionsData: {
                ...state.competitionsData,
                [competitionId]: {
                    title: competitionTitle,
                    groups: newGroups,
                    lastUpdated: new Date().toISOString()
                }
            },
            currentCompetitionId: competitionId
        };

        return { state: next };
    } catch (error) {
        console.error('Error fetching player data:', error.message);
        return { state, error: 'Failed to fetch data from API' };
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

function updateUserCheckInStatus(state, username, checkedIn) {
    const cid = state.currentCompetitionId;
    const competition = state.competitionsData[cid];
    if (!competition) return state;

    let updated = false;
    const groups = competition.groups.map((group) => {
        const updatedUsers = group.users.map((user) => {
            if (user.username === username) {
                updated = true;
                return { ...user, checkedIn };
            }
            return user;
        });
        return { ...group, users: updatedUsers };
    });

    if (!updated) return state;

    return {
        ...state,
        competitionsData: {
            ...state.competitionsData,
            [cid]: { ...competition, groups }
        }
    };
}

function updateGroupCheckInStatus(state, groupName, checkedIn) {
    const cid = state.currentCompetitionId;
    const competition = state.competitionsData[cid];
    if (!competition) return state;

    let updated = false;
    const groups = competition.groups.map((group) => {
        if (group.groupName === groupName) {
            updated = true;
            return {
                ...group,
                users: group.users.map((user) => ({ ...user, checkedIn }))
            };
        }
        return group;
    });

    if (!updated) return state;

    return {
        ...state,
        competitionsData: {
            ...state.competitionsData,
            [cid]: { ...competition, groups }
        }
    };
}

async function ensureInitialized(state) {
    const hasCurrent =
        state.competitionsData[state.currentCompetitionId] &&
        state.competitionsData[state.currentCompetitionId].groups &&
        state.competitionsData[state.currentCompetitionId].groups.length > 0;

    if (hasCurrent) {
        return state;
    }

    const result = await fetchPlayerData(state, API_BASE_URL + DEFAULT_ID);
    return result.state;
}

function normalizeStoredCompetitionId(state) {
    const raw = state.currentCompetitionId;
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

function toClientPayload(state) {
    const currentCompetition = getCurrentCompetition(state);
    const competitionId = normalizeStoredCompetitionId(state);
    return {
        groups: currentCompetition.groups,
        title: currentCompetition.title,
        currentCompetitionId: competitionId,
        currentApiUrl: API_BASE_URL + competitionId,
        counts: calculateCheckedInCounts(currentCompetition.groups)
    };
}

module.exports = {
    API_BASE_URL,
    DEFAULT_ID,
    extractCompetitionId,
    ensureApiUrl,
    getCurrentCompetition,
    fetchPlayerData,
    calculateCheckedInCounts,
    updateUserCheckInStatus,
    updateGroupCheckInStatus,
    ensureInitialized,
    normalizeStoredCompetitionId,
    toClientPayload
};

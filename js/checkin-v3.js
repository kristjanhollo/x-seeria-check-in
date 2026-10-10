console.info('Check-in frontend v3 loaded');
const API_PATH = '/api/competition';
const POLL_MS = 2000;

const API_BASE_URL = 'https://discgolfmetrix.com/api.php?content=result&id=';
let requestTail = Promise.resolve();
let pendingMutations = 0;
let currentCompetitionId = null;
let competitionRevision = null;
let rosterVersion = null;
let statusHideTimer;
let connectionErrorShown = false;

// Every GET and POST shares one queue. Responses cannot overtake each other.
function enqueueRequest(operation) {
    const result = requestTail.then(operation);
    requestTail = result.catch(() => {});
    return result;
}

async function requestApi(method, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(API_PATH, {
            method,
            cache: 'no-store',
            headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal
        });
        const data = await response.json();
        if (!response.ok) {
            const error = new Error(data.error || 'The request could not be confirmed.');
            error.code = data.code;
            error.status = response.status;
            throw error;
        }
        return data;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('The request timed out. Check the refreshed list before trying again.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function updateControls() {
    const busy = pendingMutations > 0;
    groupList.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = busy; });
    updateDataBtn.disabled = busy || currentCompetitionId === null;
    changeApiBtn.disabled = busy;
}

function fetchCompetition() {
    return enqueueRequest(async () => {
        const data = await requestApi('GET');
        // A click may have queued a write while this older poll was in flight.
        if (pendingMutations === 0) applyPayload(data);
        return data;
    });
}

function postCompetition(body) {
    // Capture the event AT THE CLICK, not after other queued responses change the page.
    const context = currentCompetitionId === null ? {} : {
        competitionId: currentCompetitionId,
        competitionRevision,
        rosterVersion
    };
    const payload = { ...body, ...context };
    if (body.action === 'changeApiUrl' || body.action === 'refreshFromApi') payload.adminPin = adminPinInput.value;
    pendingMutations++;
    updateControls();
    return enqueueRequest(async () => {
        try {
            const data = await requestApi('POST', payload);
            applyPayload(data);
            return data;
        } catch (error) {
            // Reconcile the screen after stale clicks, uncertain writes, or a rejected request.
            // This GET stays inside the same queue; do not enqueue a nested request.
            try { applyPayload(await requestApi('GET')); } catch (_) { /* The next poll retries. */ }
            throw error;
        } finally {
            pendingMutations--;
            updateControls();
        }
    });
}

function applyPayload(data) {
    if (!Array.isArray(data.groups) || !/^\d{1,20}$/.test(String(data.currentCompetitionId)) ||
        !Number.isSafeInteger(data.competitionRevision) || typeof data.rosterVersion !== 'string') {
        throw new Error('Unexpected server response. Reload the page.');
    }
    const oldId = currentCompetitionId;
    currentCompetitionId = String(data.currentCompetitionId);
    competitionRevision = data.competitionRevision;
    rosterVersion = data.rosterVersion;
    adminPinInput.hidden = !data.adminPinRequired;
    adminPinInput.style.display = data.adminPinRequired ? '' : 'none';
    if (connectionErrorShown) {
        clearTimeout(statusHideTimer);
        statusMessage.classList.add('hidden');
        connectionErrorShown = false;
    }
    if (data.groups) {
        groups = data.groups;
        displayGroups(groups);
    }
    if (data.title !== undefined) {
        competitionTitle.textContent = data.title;
        document.title = data.title;
    }
    if (data.currentApiUrl !== undefined && document.activeElement !== apiIdInput) {
        const fromField =
            data.currentCompetitionId != null && String(data.currentCompetitionId).trim() !== ''
                ? String(data.currentCompetitionId).trim()
                : '';
        const fromUrl = (() => {
            const idMatch = data.currentApiUrl.match(/id=(\d+)/);
            return idMatch && idMatch[1] ? idMatch[1] : '';
        })();
        const id = fromField || fromUrl || extractCompetitionId(data.currentApiUrl);
        apiIdInput.value = /^\d+$/.test(id) ? id : '';
    }
    if (data.counts) {
        checkedInCounter.textContent = data.counts.checkedInUsers;
        totalUsers.textContent = data.counts.totalUsers;
    }
    if (data.notice && data.notice.text) {
        showStatusMessage(data.notice.text, data.notice.type === 'error');
    } else if (oldId !== null && oldId !== currentCompetitionId) {
        showStatusMessage('The competition was changed on another device. Now showing ' + data.title + '.');
    }
    updateControls();
}

async function pollOnce() {
    try {
        await fetchCompetition();
    } catch (e) {
        console.error(e);
        connectionErrorShown = true;
        showStatusMessage(e.message || 'Could not sync with the server. Check your connection.', true);
    }
}

// Get DOM elements
const groupList = document.getElementById("groupList");
const checkedInCounter = document.getElementById("checkedInCounter");
const totalUsers = document.getElementById("totalUsers");
const filterButton = document.getElementById("filterButton");
const competitionTitle = document.getElementById("competitionTitle");
const apiIdInput = document.getElementById("apiIdInput");
const adminPinInput = document.getElementById("adminPinInput");
const changeApiBtn = document.getElementById("changeApiBtn");
const statusMessage = document.getElementById("statusMessage");
const searchInput = document.getElementById("searchInput");
const updateDataBtn = document.getElementById("updateDataBtn");
const themeToggle = document.getElementById("themeToggle");

// State variables
let groups = [];
let currentSearchQuery = ''; // Store the current search query
let filterCheckedIn = false; // Store the filter state for checked-in players/groups

function initTheme() {
    // Check for saved theme preference or use device preference
    const savedTheme = localStorage.getItem('theme') || 
                       (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    
    // Apply the theme
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    // Update the toggle button
    updateThemeToggle(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    
    // Update the document theme
    document.documentElement.setAttribute('data-theme', newTheme);
    
    // Save the preference
    localStorage.setItem('theme', newTheme);
    
    // Update the toggle button
    updateThemeToggle(newTheme);
}

function updateThemeToggle(theme) {
    // Update the SVG icon based on the current theme
    if (theme === 'dark') {
        themeToggle.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-sun">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            </svg>
        `;
    } else {
        themeToggle.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-moon">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
        `;
    }
}




// Function to display groups
function displayGroups(groups) {
    groupList.innerHTML = ''; // Clear previous groups
    groups.forEach(group => {
        const groupItem = document.createElement('div');
        groupItem.classList.add('group-item');

        const groupHeader = document.createElement('div');
        groupHeader.classList.add('group-header');
        const heading = document.createElement('h3');
        heading.textContent = group.groupName;
        const groupLabel = document.createElement('label');
        const groupCheckbox = document.createElement('input');
        groupCheckbox.type = 'checkbox';
        groupCheckbox.className = 'group-checkbox';
        groupCheckbox.checked = group.users.length > 0 && group.users.every(user => user.checkedIn);
        groupCheckbox.disabled = pendingMutations > 0;
        groupLabel.append(groupCheckbox, document.createTextNode(' Check-in all'));
        groupHeader.append(heading, groupLabel);

        const userList = document.createElement('ul');
        let allCheckedIn = true; // Assume all users are checked-in initially
        
        group.users.forEach(user => {
            const li = document.createElement('li');
            li.classList.toggle('checked-in', user.checkedIn); // Add checked-in class if true
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'check-in-checkbox';
            checkbox.checked = user.checkedIn;
            checkbox.disabled = pendingMutations > 0;
            label.append(checkbox, document.createTextNode(' ' + user.username));
            li.appendChild(label);
            checkbox.addEventListener('change', async function () {
                try {
                    await postCompetition({
                        action: 'checkInUser',
                        username: user.username,
                        checkedIn: this.checked
                    });
                } catch (e) {
                    console.error(e);
                    showStatusMessage(e.message || 'Could not confirm check-in. Check the refreshed list.', true);
                }
            });

            // If any user is not checked in, the group is not fully checked in
            if (!user.checkedIn) {
                allCheckedIn = false;
            }

            // Apply the hidden class based on the filter state for individual users
            if (filterCheckedIn && user.checkedIn) {
                li.classList.add('hidden');
            } else {
                li.classList.remove('hidden');
            }

            userList.appendChild(li);
        });

        // Hide fully checked-in groups if filter is active and all users are checked in
        if (filterCheckedIn && allCheckedIn) {
            groupItem.classList.add('hidden');
        } else {
            groupItem.classList.remove('hidden');
        }

        groupHeader.querySelector('.group-checkbox').addEventListener('change', async function () {
            try {
                await postCompetition({
                    action: 'checkInGroup',
                    groupName: group.groupName,
                    checkedIn: this.checked
                });
            } catch (e) {
                console.error(e);
                showStatusMessage(e.message || 'Could not confirm group check-in. Check the refreshed list.', true);
            }
        });

        groupItem.appendChild(groupHeader);
        groupItem.appendChild(userList);
        groupList.appendChild(groupItem);
    });

    // After displaying, apply the current search filter
    if (currentSearchQuery) {
        filterGroups(currentSearchQuery);
    }
}

// Function to filter groups and users based on search query
function filterGroups(searchQuery) {
    currentSearchQuery = searchQuery.toLowerCase(); // Store current search query
    const groupItems = Array.from(document.querySelectorAll('.group-item'));

    if (!currentSearchQuery) {
        // If search query is empty, just apply the filter checked-in state
        applyFilterCheckedIn();
        return;
    }

    groupItems.forEach(groupItem => {
        const groupName = groupItem.querySelector('h3').textContent.toLowerCase();
        const userListItems = Array.from(groupItem.querySelectorAll('li'));

        // Filter users within the group based on search query
        let userMatches = false;
        userListItems.forEach(li => {
            const username = li.querySelector('label').textContent.trim().toLowerCase();
            const isCheckedIn = li.classList.contains('checked-in');
            
            // Hide user if it doesn't match search or is filtered out due to being checked in
            const hideBySearch = !username.includes(currentSearchQuery);
            const hideByFilter = filterCheckedIn && isCheckedIn;
            
            if (hideBySearch || hideByFilter) {
                li.classList.add('hidden');
            } else {
                li.classList.remove('hidden');
                userMatches = true;
            }
        });

        // Show the entire group if the group name matches the search query
        if (groupName.includes(currentSearchQuery)) {
            groupItem.classList.remove('hidden');  // Show group
            
            // Show only non-filtered users
            userListItems.forEach(li => {
                const isCheckedIn = li.classList.contains('checked-in');
                if (filterCheckedIn && isCheckedIn) {
                    li.classList.add('hidden');
                } else {
                    li.classList.remove('hidden');
                }
            });
        } else if (userMatches) {
            groupItem.classList.remove('hidden');  // Show group but filtered users
        } else {
            groupItem.classList.add('hidden');  // Hide the group
        }
    });
}

// Function to apply just the filter for checked-in users
function applyFilterCheckedIn() {
    const groupItems = Array.from(document.querySelectorAll('.group-item'));
    
    groupItems.forEach(groupItem => {
        const userListItems = Array.from(groupItem.querySelectorAll('li'));
        let allCheckedIn = true;
        let anyVisible = false;
        
        userListItems.forEach(li => {
            const isCheckedIn = li.classList.contains('checked-in');
            if (filterCheckedIn && isCheckedIn) {
                li.classList.add('hidden');
            } else {
                li.classList.remove('hidden');
                anyVisible = true;
            }
            
            if (!isCheckedIn) {
                allCheckedIn = false;
            }
        });
        
        // Hide groups where all users are checked in and filter is active
        if (filterCheckedIn && allCheckedIn) {
            groupItem.classList.add('hidden');
        } else if (!anyVisible) {
            groupItem.classList.add('hidden');
        } else {
            groupItem.classList.remove('hidden');
        }
    });
}

// Function to toggle the filter for checked-in users and groups
function toggleFilter() {
    filterCheckedIn = !filterCheckedIn; // Toggle the filter state
    
    // Update the button text based on filter state
    filterButton.textContent = filterCheckedIn ? 'Filter ON' : 'Filter OFF';
    filterButton.classList.toggle('btn-warning', !filterCheckedIn);
    filterButton.classList.toggle('btn-primary', filterCheckedIn);
    
    // Apply the filter without messing with the search
    if (currentSearchQuery) {
        filterGroups(currentSearchQuery);
    } else {
        applyFilterCheckedIn();
    }
}

// Function to show status message
function showStatusMessage(message, isError = false) {
    clearTimeout(statusHideTimer);
    statusMessage.textContent = message;
    statusMessage.classList.remove('hidden', 'status-success', 'status-error');
    statusMessage.classList.add(isError ? 'status-error' : 'status-success');
    
    // Auto-hide after 5 seconds
    if (!isError) statusHideTimer = setTimeout(() => {
        statusMessage.classList.add('hidden');
    }, 5000);
}

// Function to extract competition ID from full URL
function extractCompetitionId(url) {
    // If it's already just the ID (a number), return it
    if (/^\d+$/.test(url)) {
        return url;
    }
    
    // Try to extract ID from full URL
    const idMatch = url.match(/id=(\d+)/);
    if (idMatch && idMatch[1]) {
        return idMatch[1];
    }
    try {
        const parsed = new URL(url);
        const id = parsed.pathname.replace(/^\/+|\/+$/g, '');
        if (['discgolfmetrix.com', 'www.discgolfmetrix.com'].includes(parsed.hostname) && /^\d+$/.test(id)) return id;
    } catch (_) { /* The caller displays a validation message. */ }
    
    // If no match, return the original value
    return url;
}

// ===== EVENT LISTENERS =====

initTheme();

// Theme toggle click
themeToggle.addEventListener('click', toggleTheme);

// Search input handling
searchInput.addEventListener('focus', function() {
    searchInput.value = ''; // Clear the search bar
    currentSearchQuery = '';
    applyFilterCheckedIn(); // Reset displayed groups and users, keeping filter state
});

searchInput.addEventListener('input', function() {
    filterGroups(searchInput.value); // Apply search filter when typing
});

// Filter button click
filterButton.addEventListener('click', toggleFilter);

// Update data button click
updateDataBtn.addEventListener('click', async function () {
    updateDataBtn.textContent = 'Updating...';
    updateDataBtn.disabled = true;
    try {
        await postCompetition({ action: 'refreshFromApi' });
    } catch (e) {
        console.error(e);
        showStatusMessage(e.message || 'Failed to refresh data', true);
    } finally {
        updateDataBtn.textContent = 'Update Data';
        updateControls();
    }
});

// Change API button click
changeApiBtn.addEventListener('click', async function () {
    const competitionId = apiIdInput.value.trim();
    if (!/^\d{1,20}$/.test(extractCompetitionId(competitionId))) {
        showStatusMessage('Please enter a valid competition ID', true);
        return;
    }
    changeApiBtn.textContent = 'Loading...';
    changeApiBtn.disabled = true;
    try {
        const cleanId = extractCompetitionId(competitionId);
        const newApiUrl = API_BASE_URL + cleanId;
        await postCompetition({ action: 'changeApiUrl', apiUrl: newApiUrl });
    } catch (e) {
        console.error(e);
        showStatusMessage(e.message || 'Failed to load competition', true);
    } finally {
        changeApiBtn.textContent = 'Change Competition';
        updateControls();
    }
});

// Enter key in API input field
apiIdInput.addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        changeApiBtn.click();
    }
});

// Poll server state so multiple devices stay in sync (replaces Socket.IO on Vercel)
updateControls();
async function pollLoop() {
    await pollOnce();
    setTimeout(pollLoop, POLL_MS);
}
pollLoop();

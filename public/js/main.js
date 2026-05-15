const API_PATH = '/api/competition';
const POLL_MS = 2000;

const API_BASE_URL = 'https://discgolfmetrix.com/api.php?content=result&id=';

async function fetchCompetition() {
    const r = await fetch(API_PATH, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
}

async function postCompetition(body) {
    const r = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
}

function applyPayload(data) {
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
    }
}

async function pollOnce() {
    try {
        const data = await fetchCompetition();
        applyPayload(data);
    } catch (e) {
        console.error(e);
    }
}

// Get DOM elements
const groupList = document.getElementById("groupList");
const checkedInCounter = document.getElementById("checkedInCounter");
const totalUsers = document.getElementById("totalUsers");
const filterButton = document.getElementById("filterButton");
const competitionTitle = document.getElementById("competitionTitle");
const apiIdInput = document.getElementById("apiIdInput");
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

        const allCheckedInGroup = group.users.every(user => user.checkedIn);
        
        const groupHeader = document.createElement('div');
        groupHeader.classList.add('group-header');
        groupHeader.innerHTML = `
            <h3>${group.groupName}</h3>
            <label>
                <input type="checkbox" class="group-checkbox" ${group.users.every(u => u.checkedIn) ? 'checked' : ''}>
                Check-in all
            </label>
        `;

        const userList = document.createElement('ul');
        let allCheckedIn = true; // Assume all users are checked-in initially
        
        group.users.forEach(user => {
            const li = document.createElement('li');
            li.classList.toggle('checked-in', user.checkedIn); // Add checked-in class if true
            li.innerHTML = `
                <label>
                    <input type="checkbox" class="check-in-checkbox" id="${user.username}" ${user.checkedIn ? 'checked' : ''}>
                    ${user.username}
                </label>
            `;

            const checkbox = li.querySelector('input[type="checkbox"]');
            checkbox.addEventListener('change', async function () {
                try {
                    const data = await postCompetition({
                        action: 'checkInUser',
                        username: user.username,
                        checkedIn: this.checked
                    });
                    applyPayload(data);
                } catch (e) {
                    console.error(e);
                    showStatusMessage('Could not update check-in', true);
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
                const data = await postCompetition({
                    action: 'checkInGroup',
                    groupName: group.groupName,
                    checkedIn: this.checked
                });
                applyPayload(data);
            } catch (e) {
                console.error(e);
                showStatusMessage('Could not update group check-in', true);
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
            console.log('Checked in:', isCheckedIn); // Debugging line
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
    statusMessage.textContent = message;
    statusMessage.classList.remove('hidden', 'status-success', 'status-error');
    statusMessage.classList.add(isError ? 'status-error' : 'status-success');
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
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
        const data = await postCompetition({ action: 'refreshFromApi' });
        applyPayload(data);
    } catch (e) {
        console.error(e);
        showStatusMessage('Failed to refresh data', true);
    } finally {
        updateDataBtn.textContent = 'Update Data';
        updateDataBtn.disabled = false;
    }
});

// Change API button click
changeApiBtn.addEventListener('click', async function () {
    const competitionId = apiIdInput.value.trim();
    if (!competitionId) {
        showStatusMessage('Please enter a valid competition ID', true);
        return;
    }
    changeApiBtn.textContent = 'Loading...';
    changeApiBtn.disabled = true;
    try {
        const cleanId = extractCompetitionId(competitionId);
        const newApiUrl = API_BASE_URL + cleanId;
        const data = await postCompetition({ action: 'changeApiUrl', apiUrl: newApiUrl });
        applyPayload(data);
    } catch (e) {
        console.error(e);
        showStatusMessage('Failed to load competition', true);
    } finally {
        changeApiBtn.textContent = 'Change Competition';
        changeApiBtn.disabled = false;
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
pollOnce();
setInterval(pollOnce, POLL_MS);
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');

let mainWindow;
let client;
let nextSendTime = null;
let scheduledJobs = new Map();

// Constants
const activityLogPath = path.join(process.cwd(), 'activity_log.json');
const indexFilePath = path.resolve('image_index.json');
const scheduleConfigPath = path.join(process.cwd(), 'schedule_config.json');

// Campaign / safety defaults (user provided)
const campaignDefaults = {
    sendingPace: 'VERY_CAUTIOUS', // default
    // delays in seconds
    VERY_CAUTIOUS: { minDelay: 60, maxDelay: 120, pauseAfterGroups: 5, pauseMin: 180, pauseMax: 300 },
    CAUTIOUS: { minDelay: 30, maxDelay: 60, pauseAfterGroups: 5, pauseMin: 120, pauseMax: 300 },
    CUSTOM: { minDelay: 30, maxDelay: 60, pauseAfterGroups: 5, pauseMin: 120, pauseMax: 300 },
    maxGroupsPerCampaign: 20,
    maxRetries: 1,
    duplicateWindowHours: 24
};

// Path to save simple sent records for duplicate protection
const sentRecordsPath = path.join(process.cwd(), 'sent_records.json');

// Schedule configuration
let scheduleConfig = {
    type: 'interval',
    intervalHours: 24,
    dailyTimes: [],
    customSchedule: {
        0: [], // Sunday
        1: [], // Monday
        2: [], // Tuesday
        3: [], // Wednesday
        4: [], // Thursday
        5: [], // Friday
        6: []  // Saturday
    },
    active: false
};

// Campaign State
let campaignState = {
    running: false,
    paused: false,
    stopRequested: false,
    currentIndex: 0,
    totalGroups: 0,
    progress: [] // {groupId, groupName, status}
};

// Helper Functions
function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

function logError(error, context = '') {
    try {
        const logFile = path.join(process.cwd(), 'logs', 'error.log');
        const timestamp = new Date().toISOString();
        const logEntry = `${timestamp} - ${context}: ${error.message}\n${error.stack}\n\n`;
        fs.appendFileSync(logFile, logEntry);
    } catch (err) {
        console.error('Error writing to log file:', err);
    }
}

// Activity Management
function initializeActivityLog() {
    try {
        if (!fs.existsSync(activityLogPath)) {
            fs.writeFileSync(activityLogPath, JSON.stringify({
                activities: [],
                remainingImages: 0
            }, null, 2));
        }
    } catch (error) {
        logError(error, 'initializeActivityLog');
    }
}

function logActivity(activity) {
    try {
        let logData = { activities: [], remainingImages: 0 };
        
        if (fs.existsSync(activityLogPath)) {
            const fileContent = fs.readFileSync(activityLogPath, 'utf8');
            logData = JSON.parse(fileContent);
        }

        // Calculate remaining images
        const imageDir = path.join(process.cwd(), 'images');
        const currentIndex = getCurrentIndex();
        const remainingImages = fs.readdirSync(imageDir)
            .filter(file => file.toLowerCase().endsWith('.jpg')).length - currentIndex;

        // Add new activity to the beginning of the array
        logData.activities.unshift({
            ...activity,
            timestamp: new Date().toISOString()
        });

        // Keep only last 50 activities
        logData.activities = logData.activities.slice(0, 50);
        logData.remainingImages = remainingImages;

        // Write updated data back to file
        fs.writeFileSync(activityLogPath, JSON.stringify(logData, null, 2));

        // Send update to renderer
        sendToRenderer('activity-update', logData.activities);

    } catch (error) {
        console.error('Error logging activity:', error);
        logError(error, 'logActivity');
    }
}

// Index Management
function getCurrentIndex() {
    try {
        if (fs.existsSync(indexFilePath)) {
            const data = fs.readFileSync(indexFilePath, 'utf8');
            return JSON.parse(data).index || 0;
        }
        return 0;
    } catch (error) {
        logError(error, 'getCurrentIndex');
        return 0;
    }
}

function saveCurrentIndex(index) {
    try {
        fs.writeFileSync(indexFilePath, JSON.stringify({ index }));
    } catch (error) {
        logError(error, 'saveCurrentIndex');
        throw error;
    }
}

// Directory Management
function ensureDirectories() {
    const dirs = [
        path.join(process.cwd(), 'images'),
        path.join(process.cwd(), '.wwebjs_auth'),
        path.join(process.cwd(), 'logs')
    ];

    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// Window Management
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'icon.ico')
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// WhatsApp Client Management
async function initializeWhatsApp() {
    try {
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: 'my_custom_session',
                dataPath: path.join(process.cwd(), '.wwebjs_auth')
            }),
            puppeteer: {
                headless: true,
                defaultViewport: null,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--allow-running-insecure-content',
                    '--disable-features=IsolateOrigins,site-per-process'
                ],
                ignoreDefaultArgs: ['--disable-extensions'],
                executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        });

        client.on('qr', async (qr) => {
            try {
                const dataURL = await qrcode.toDataURL(qr);
                sendToRenderer('qr-code', dataURL);
            } catch (err) {
                console.error('QR Code generation error:', err);
                sendToRenderer('error', 'Failed to generate QR code');
            }
        });

        client.on('ready', () => {
            sendToRenderer('whatsapp-ready');
            console.log('WhatsApp client is ready!');
            fetchGroups();
        });

        client.on('disconnected', async (reason) => {
            console.log('Client disconnected:', reason);
            sendToRenderer('disconnected', reason);
            try {
                await client.initialize();
            } catch (error) {
                console.error('Failed to reconnect:', error);
            }
        });

        await client.initialize();

    } catch (error) {
        console.error('Failed to initialize WhatsApp client:', error);
        sendToRenderer('error', 'Failed to initialize WhatsApp');
        throw error;
    }
}
// Group Management
async function fetchGroups() {
    try {
        const chats = await client.getChats();
        const groups = chats
            .filter(chat => chat.id._serialized.endsWith('@g.us'))
            .map(group => ({
                id: group.id._serialized,
                name: group.name
            }));

        sendToRenderer('groups-loaded', groups);
    } catch (error) {
        console.error('Error fetching groups:', error);
        sendToRenderer('error', 'Failed to fetch WhatsApp groups');
    }
}

// Message Sending Functions
function validateGroupId(groupId) {
    if (!groupId || typeof groupId !== 'string') {
        throw new Error('Group ID is required');
    }
    if (!groupId.endsWith('@g.us')) {
        throw new Error('Invalid group ID format. Must end with @g.us');
    }
    return true;
}

async function sendMessage(groupId, message) {
    try {
        await client.sendMessage(groupId, message);
        console.log(`Message sent to group ${groupId}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return true;
    } catch (error) {
        console.error(`Failed to send message to group ${groupId}:`, error);
        return false;
    }
}

async function sendMediaToGroup(groupId, media, delay = 2000) {
    try {
        await client.sendMessage(groupId, media);
        await new Promise(resolve => setTimeout(resolve, delay));
        return true;
    } catch (error) {
        console.error(`Failed to send media to group ${groupId}:`, error);
        return false;
    }
}

async function sendToGroups(groupIds, message, includeImages = true, imageCount = 4) {
    try {
        const groups = Array.isArray(groupIds) ? groupIds : [groupIds];
        groups.forEach(groupId => validateGroupId(groupId));

        let successfulGroups = 0;
        let currentIndex = getCurrentIndex();
        let imagesToSend = [];

        if (includeImages) {
            const imageDir = path.join(process.cwd(), 'images');
            const imageFiles = fs.readdirSync(imageDir)
                .filter(file => file.toLowerCase().endsWith('.jpg'))
                .sort((a, b) => {
                    const numA = parseInt(a.match(/\d+/) || [0]);
                    const numB = parseInt(b.match(/\d+/) || [0]);
                    return numA - numB;
                });

            imagesToSend = imageFiles.slice(currentIndex, currentIndex + imageCount);

            if (imagesToSend.length === 0 && includeImages) {
                sendToRenderer('send-error', 'No images available to send');
                return;
            }
        }

        for (const groupId of groups) {
            let groupSuccess = true;
            const chat = await client.getChatById(groupId);
            const groupName = chat.name;

            try {
                if (message && message.trim()) {
                    const messageSent = await sendMessage(groupId, message.trim());
                    if (!messageSent) {
                        console.warn(`Failed to send message to group ${groupId}`);
                        groupSuccess = false;
                    }
                }

                if (includeImages) {
                    for (const imageFile of imagesToSend) {
                        const imagePath = path.join(process.cwd(), 'images', imageFile);
                        if (!fs.existsSync(imagePath)) {
                            console.error(`Image not found: ${imagePath}`);
                            groupSuccess = false;
                            continue;
                        }

                        const media = MessageMedia.fromFilePath(imagePath);
                        const sent = await sendMediaToGroup(groupId, media);
                        if (!sent) {
                            groupSuccess = false;
                        }
                    }
                }

                if (groupSuccess) {
                    successfulGroups++;
                }

                logActivity({
                    groupName,
                    imageCount: includeImages ? imagesToSend.length : 0,
                    message: !!message.trim(),
                    success: groupSuccess
                });

            } catch (error) {
                logError(error, `sendToGroups - ${groupId}`);
                groupSuccess = false;
                
                logActivity({
                    groupName,
                    imageCount: 0,
                    message: !!message.trim(),
                    success: false
                });
            }
        }

        if (successfulGroups > 0 && includeImages) {
            currentIndex += imagesToSend.length;
            saveCurrentIndex(currentIndex);
        }

        sendToRenderer('send-complete', {
            sentCount: includeImages ? imagesToSend.length : 0,
            nextIndex: currentIndex,
            messageSent: !!message.trim(),
            groupCount: successfulGroups,
            totalGroups: groups.length,
            messageOnly: !includeImages
        });

    } catch (error) {
        logError(error, 'sendToGroups');
        console.error('Error in sendToGroups:', error);
        sendToRenderer('send-error', error.message);
        throw error;
    }
}

// --- New Campaign Controller: sequential sending with randomized delays, pause/resume/stop ---

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getRandomInt(min, max) {
    // inclusive
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function safeWaitSeconds(seconds) {
    // Waits up to `seconds` seconds but exits early if campaign paused/stopped
    let remaining = seconds;
    while (remaining > 0) {
        if (campaignState.stopRequested) throw new Error('Campaign stopped');
        if (campaignState.paused) {
            // while paused, just wait and don't decrement remaining
            await sleep(500);
            continue;
        }
        // wait in 1s increments so we can update UI
        await sleep(1000);
        remaining -= 1;
        // notify renderer of remaining wait when appropriate
        sendToRenderer('campaign-waiting', { remaining });
    }
}

function loadSentRecords() {
    try {
        if (!fs.existsSync(sentRecordsPath)) return [];
        const raw = fs.readFileSync(sentRecordsPath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        logError(err, 'loadSentRecords');
        return [];
    }
}

function saveSentRecord(record) {
    try {
        const data = loadSentRecords();
        data.unshift(record);
        // keep only recent 1000 records to avoid huge files
        fs.writeFileSync(sentRecordsPath, JSON.stringify(data.slice(0, 1000), null, 2));
    } catch (err) {
        logError(err, 'saveSentRecord');
    }
}

function wasRecentlySent(adHash, groupId, hoursWindow) {
    try {
        const data = loadSentRecords();
        const cutoff = Date.now() - hoursWindow * 3600 * 1000;
        return data.some(r => r.adHash === adHash && r.groupId === groupId && new Date(r.timestamp).getTime() >= cutoff);
    } catch (err) {
        logError(err, 'wasRecentlySent');
        return false;
    }
}

async function sendCampaign(groupIds, message, includeImages = true, imageCount = 4, options = {}) {
    // options: { minDelay, maxDelay, pauseAfterGroups, pauseMin, pauseMax, maxGroups, maxRetries, dryRun }
    const opts = Object.assign({}, {
        minDelay: campaignDefaults.VERY_CAUTIOUS.minDelay,
        maxDelay: campaignDefaults.VERY_CAUTIOUS.maxDelay,
        pauseAfterGroups: campaignDefaults.VERY_CAUTIOUS.pauseAfterGroups,
        pauseMin: campaignDefaults.VERY_CAUTIOUS.pauseMin,
        pauseMax: campaignDefaults.VERY_CAUTIOUS.pauseMax,
        maxGroups: campaignDefaults.maxGroupsPerCampaign,
        maxRetries: campaignDefaults.maxRetries,
        dryRun: false
    }, options);

    // Respect the maxGroups limit
    const groups = Array.isArray(groupIds) ? groupIds.slice(0, opts.maxGroups) : [groupIds];
    groups.forEach(groupId => validateGroupId(groupId));

    campaignState.running = true;
    campaignState.paused = false;
    campaignState.stopRequested = false;
    campaignState.currentIndex = 0;
    campaignState.totalGroups = groups.length;
    campaignState.progress = groups.map(g => ({ groupId: g, status: 'Pending' }));

    sendToRenderer('campaign-started', { totalGroups: groups.length });

    // prepare images list once
    let imagesToSend = [];
    if (includeImages) {
        const imageDir = path.join(process.cwd(), 'images');
        const imageFiles = fs.readdirSync(imageDir)
            .filter(file => file.toLowerCase().endsWith('.jpg'))
            .sort((a, b) => {
                const numA = parseInt(a.match(/\d+/) || [0]);
                const numB = parseInt(b.match(/\d+/) || [0]);
                return numA - numB;
            });

        let currentIndex = getCurrentIndex();
        imagesToSend = imageFiles.slice(currentIndex, currentIndex + imageCount);
    }

    // Simple ad hash for duplicate detection: use message + filenames
    const adHash = `${(message||'').trim().slice(0,200)}|${imagesToSend.join(',')}`;

    for (let i = 0; i < groups.length; i++) {
        const groupId = groups[i];
        campaignState.currentIndex = i + 1;

        // check stop
        if (campaignState.stopRequested) break;

        // wait while paused
        while (campaignState.paused) {
            sendToRenderer('campaign-status', { index: campaignState.currentIndex, total: campaignState.totalGroups, status: 'Paused' });
            await sleep(500);
            if (campaignState.stopRequested) break;
        }
        if (campaignState.stopRequested) break;

        // fetch group name
        let groupName = groupId;
        try {
            const chat = await client.getChatById(groupId);
            groupName = chat.name || groupId;
        } catch (err) {
            logError(err, `sendCampaign:getChatById - ${groupId}`);
        }

        // duplicate check
        const recently = wasRecentlySent(adHash, groupId, campaignDefaults.duplicateWindowHours);
        if (recently && !opts.dryRun) {
            // warn renderer and let it decide (renderer could send back a control; for now, we'll skip by default)
            sendToRenderer('duplicate-warning', { groupId, groupName });
            // default behavior: skip
            campaignState.progress[i] = { groupId, groupName, status: 'Skipped (Duplicate)' };
            sendToRenderer('campaign-progress', { index: campaignState.currentIndex, total: campaignState.totalGroups, groupId, groupName, status: 'Skipped (Duplicate)' });
            continue;
        }

        // Start sending
        sendToRenderer('campaign-progress', { index: campaignState.currentIndex, total: campaignState.totalGroups, groupId, groupName, status: 'Sending' });

        let groupSuccess = true;
        // attempt send with retries
        let attempts = 0;
        do {
            attempts++;
            try {
                if (!opts.dryRun) {
                    // send message if present
                    if (message && message.trim()) {
                        const ok = await sendMessage(groupId, message.trim());
                        if (!ok) throw new Error('Message send failed');
                    }

                    // send images
                    if (includeImages) {
                        for (const imageFile of imagesToSend) {
                            const imagePath = path.join(process.cwd(), 'images', imageFile);
                            if (!fs.existsSync(imagePath)) {
                                throw new Error(`Image not found ${imagePath}`);
                            }
                            const media = MessageMedia.fromFilePath(imagePath);
                            const ok = await sendMediaToGroup(groupId, media);
                            if (!ok) throw new Error('Media send failed');
                        }
                    }

                    // record sent
                    saveSentRecord({ adHash, groupId, groupName, timestamp: new Date().toISOString() });
                } else {
                    // Dry run: simulate a small delay
                    await sleep(500);
                }

                groupSuccess = true;
                campaignState.progress[i] = { groupId, groupName, status: 'Sent' };
                sendToRenderer('campaign-progress', { index: campaignState.currentIndex, total: campaignState.totalGroups, groupId, groupName, status: 'Sent' });
                logActivity({ groupName, imageCount: includeImages ? imagesToSend.length : 0, message: !!message.trim(), success: true });
                break; // success
            } catch (err) {
                logError(err, `sendCampaign - ${groupId} attempt ${attempts}`);
                console.error(`sendCampaign error for ${groupId} attempt ${attempts}:`, err.message || err);
                if (attempts > opts.maxRetries) {
                    groupSuccess = false;
                    campaignState.progress[i] = { groupId, groupName, status: 'Failed' };
                    sendToRenderer('campaign-progress', { index: campaignState.currentIndex, total: campaignState.totalGroups, groupId, groupName, status: 'Failed' });
                    logActivity({ groupName, imageCount: 0, message: !!message.trim(), success: false });
                    break;
                } else {
                    // short delay before retry
                    await sleep(2000);
                }
            }
        } while (attempts <= opts.maxRetries && !campaignState.stopRequested);

        // After each group, unless final or stopped, wait randomized delay
        if (campaignState.stopRequested) break;

        // long break after every pauseAfterGroups
        if ((i + 1) % opts.pauseAfterGroups === 0 && (i + 1) < groups.length) {
            const pauseSec = getRandomInt(opts.pauseMin, opts.pauseMax);
            sendToRenderer('campaign-status', { index: campaignState.currentIndex, total: campaignState.totalGroups, status: `Pausing for ${pauseSec} seconds` });
            try {
                await safeWaitSeconds(pauseSec);
            } catch (err) {
                // stopped
                break;
            }
        } else if ((i + 1) < groups.length) {
            const delaySec = getRandomInt(opts.minDelay, opts.maxDelay);
            sendToRenderer('campaign-status', { index: campaignState.currentIndex, total: campaignState.totalGroups, status: `Waiting ${delaySec} seconds before next group` });
            try {
                await safeWaitSeconds(delaySec);
            } catch (err) {
                // stopped
                break;
            }
        }
    }

    campaignState.running = false;
    campaignState.paused = false;
    campaignState.stopRequested = false;

    // Prepare final report
    const report = {
        totalSelected: campaignState.totalGroups,
        sent: campaignState.progress.filter(p => p.status === 'Sent').length,
        failed: campaignState.progress.filter(p => p.status === 'Failed').length,
        skipped: campaignState.progress.filter(p => String(p.status).toLowerCase().includes('skip')).length,
        details: campaignState.progress
    };

    sendToRenderer('campaign-complete', report);
    return report;
}

// --- End Campaign Controller ---

// Schedule Management Functions
function clearAllScheduledJobs() {
    scheduledJobs.forEach(job => clearTimeout(job));
    scheduledJobs.clear();
}

function getNextScheduledTime(config) {
    const now = new Date();
    
    switch(config.type) {
        case 'interval':
            return new Date(now.getTime() + config.intervalHours * 60 * 60 * 1000);
            
        case 'daily':
            let nextTime = null;
            for (const timeStr of config.dailyTimes) {
                const [hours, minutes] = timeStr.split(':').map(Number);
                const scheduledTime = new Date(now);
                scheduledTime.setHours(hours, minutes, 0, 0);
                
                if (scheduledTime <= now) {
                    scheduledTime.setDate(scheduledTime.getDate() + 1);
                }
                
                if (!nextTime || scheduledTime < nextTime) {
                    nextTime = scheduledTime;
                }
            }
            return nextTime;
            
        case 'custom':
            let nextCustomTime = null;
            const currentDay = now.getDay();
            
            for (let i = 0; i < 7; i++) {
                const checkDay = (currentDay + i) % 7;
                const dayTimes = config.customSchedule[checkDay];
                
                for (const timeStr of dayTimes) {
                    const [hours, minutes] = timeStr.split(':').map(Number);
                    const scheduledTime = new Date(now);
                    scheduledTime.setDate(now.getDate() + i);
                    scheduledTime.setHours(hours, minutes, 0, 0);
                    
                    if (scheduledTime > now && (!nextCustomTime || scheduledTime < nextCustomTime)) {
                        nextCustomTime = scheduledTime;
                    }
                }
            }
            return nextCustomTime;
            
        default:
            throw new Error('Invalid schedule type');
    }
}
async function scheduleNextRun(groupIds, message, imageCount) {
    if (!scheduleConfig.active) return;
    
    const nextTime = getNextScheduledTime(scheduleConfig);
    if (!nextTime) {
        console.error('No valid schedule times configured');
        sendToRenderer('schedule-error', 'No valid schedule times configured');
        return;
    }
    
    const timeUntilNext = nextTime.getTime() - Date.now();
    const jobId = setTimeout(async () => {
        try {
            await sendToGroups(groupIds, message, true, imageCount);
            scheduledJobs.delete(jobId);
            scheduleNextRun(groupIds, message, imageCount);
        } catch (error) {
            console.error('Scheduled send failed:', error);
            sendToRenderer('send-error', error.message);
        }
    }, timeUntilNext);
    
    scheduledJobs.set(jobId, jobId);
    sendToRenderer('next-send-time', nextTime.getTime());
    updateCountdown(nextTime);
}

function updateCountdown(targetTime) {
    if (!targetTime) return;

    const interval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            clearInterval(interval);
            return;
        }

        const now = new Date();
        const timeDiff = targetTime - now;

        if (timeDiff <= 0) {
            clearInterval(interval);
            return;
        }

        const hours = Math.floor(timeDiff / (1000 * 60 * 60));
        const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeDiff % (1000 * 60)) / 1000);

        sendToRenderer('countdown-update', { hours, minutes, seconds });
    }, 1000);
}

function startCustomSchedule(config, groupIds, message, imageCount) {
    try {
        stopSchedule(); // Clear existing schedule
        scheduleConfig = { ...config, active: true };
        scheduleNextRun(groupIds, message, imageCount);
        saveScheduleConfig();
        
        sendToRenderer('schedule-started', {
            groupCount: groupIds.length,
            scheduleType: config.type
        });
        
    } catch (error) {
        logError(error, 'startCustomSchedule');
        console.error('Error starting custom schedule:', error);
        sendToRenderer('error', error.message);
        throw error;
    }
}

function stopSchedule() {
    clearAllScheduledJobs();
    scheduleConfig.active = false;
    saveScheduleConfig();
    sendToRenderer('schedule-stopped');
}

// Config Persistence
function saveScheduleConfig() {
    try {
        fs.writeFileSync(scheduleConfigPath, JSON.stringify(scheduleConfig, null, 2));
    } catch (error) {
        logError(error, 'saveScheduleConfig');
    }
}

function loadScheduleConfig() {
    try {
        if (fs.existsSync(scheduleConfigPath)) {
            const data = fs.readFileSync(scheduleConfigPath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        logError(error, 'loadScheduleConfig');
    }
    return null;
}

// Application Event Handlers
app.whenReady().then(async () => {
    try {
        ensureDirectories();
        createWindow();
        await initializeWhatsApp();
        initializeActivityLog();
        
        const savedConfig = loadScheduleConfig();
        if (savedConfig && savedConfig.active) {
            scheduleConfig = savedConfig;
        }

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    } catch (error) {
        logError(error, 'app.whenReady');
        console.error('Error during app initialization:', error);
        dialog.showErrorBox('Initialization Error', 
            'Failed to initialize the application. Check the logs for details.');
    }
});

app.on('window-all-closed', () => {
    stopSchedule();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers
ipcMain.on('send-message', async (event, { groupIds, message }) => {
    try {
        if (!client) {
            throw new Error('WhatsApp client not initialized');
        }
        await sendToGroups(groupIds, message, false);
    } catch (error) {
        logError(error, 'ipcMain.send-message');
        console.error('Error sending message:', error);
        sendToRenderer('send-error', error.message);
    }
});

ipcMain.on('send-images', async (event, { groupIds, message, imageCount = 4 }) => {
    try {
        if (!client) {
            throw new Error('WhatsApp client not initialized');
        }
        await sendToGroups(groupIds, message, true, imageCount);
    } catch (error) {
        logError(error, 'ipcMain.send-images');
        console.error('Error sending images:', error);
        sendToRenderer('send-error', error.message);
    }
});

ipcMain.on('start-custom-schedule', (event, { scheduleConfig: newConfig, groupIds, message, imageCount }) => {
    try {
        if (!client) {
            throw new Error('WhatsApp client not initialized');
        }
        startCustomSchedule(newConfig, groupIds, message, imageCount);
    } catch (error) {
        logError(error, 'ipcMain.start-custom-schedule');
        console.error('Error starting custom schedule:', error);
        sendToRenderer('error', error.message);
    }
});

ipcMain.on('stop-schedule', () => {
    try {
        stopSchedule();
    } catch (error) {
        logError(error, 'ipcMain.stop-schedule');
        console.error('Error stopping schedule:', error);
        sendToRenderer('error', error.message);
    }
});

ipcMain.handle('get-image-queue', async () => {
    try {
        const imageDir = path.join(process.cwd(), 'images');
        const currentIndex = getCurrentIndex();
        const imageFiles = fs.readdirSync(imageDir)
            .filter(file => file.toLowerCase().endsWith('.jpg'))
            .sort((a, b) => {
                const numA = parseInt(a.match(/\d+/) || [0]);
                const numB = parseInt(b.match(/\d+/) || [0]);
                return numA - numB;
            })
            .slice(currentIndex, currentIndex + 4)
            .map(filename => path.join(imageDir, filename).replace(/\\/g, '/'));
        
        return imageFiles;
    } catch (error) {
        logError(error, 'get-image-queue');
        console.error('Error getting image queue:', error);
        return [];
    }
});

ipcMain.on('refresh-groups', async () => {
    try {
        await fetchGroups();
    } catch (error) {
        console.error('Error refreshing groups:', error);
        sendToRenderer('error', 'Failed to refresh groups');
    }
});
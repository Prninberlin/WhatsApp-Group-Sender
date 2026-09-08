const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const crypto = require('crypto');
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
const savedGroupsPath = path.join(process.cwd(), 'saved_groups.json');

// Campaign / safety defaults (user provided)
const campaignDefaults = {
    sendingPace: 'VERY_CAUTIOUS', // default
    // delays in seconds
    VERY_CAUTIOUS: { minDelay: 10, maxDelay: 20, pauseAfterGroups: 5, pauseMin: 10, pauseMax: 10 },
    CAUTIOUS: { minDelay: 30, maxDelay: 60, pauseAfterGroups: 5, pauseMin: 120, pauseMax: 300 },
    CUSTOM: { minDelay: 30, maxDelay: 60, pauseAfterGroups: 5, pauseMin: 120, pauseMax: 300 },
    maxGroupsPerCampaign: 20,
    maxRetries: 1,
    duplicateWindowHours: 0.5
};

// Path to save simple sent records for duplicate protection
const sentRecordsPath = path.join(process.cwd(), 'sent_records.json');
const messageHistoryPath = path.join(process.cwd(), 'sent_message_history.json');

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

const supportedImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isSupportedImageFile(filename) {
    return supportedImageExtensions.has(path.extname(filename).toLowerCase());
}

function numericImageSort(a, b) {
    const numA = parseInt(path.basename(a).match(/\d+/) || [0]);
    const numB = parseInt(path.basename(b).match(/\d+/) || [0]);
    return numA - numB;
}

function getSelectedImagesDir() {
    return path.join(app.getPath('userData'), 'selected_images');
}

function getSelectedImagePaths() {
    const selectedDir = getSelectedImagesDir();
    if (!fs.existsSync(selectedDir)) return [];

    return fs.readdirSync(selectedDir)
        .filter(isSupportedImageFile)
        .sort(numericImageSort)
        .map(filename => path.join(selectedDir, filename));
}

function getLegacyQueuedImagePaths(imageCount = 4) {
    const imageDir = path.join(process.cwd(), 'images');
    if (!fs.existsSync(imageDir)) return [];

    const currentIndex = getCurrentIndex();
    return fs.readdirSync(imageDir)
        .filter(isSupportedImageFile)
        .sort(numericImageSort)
        .slice(currentIndex, currentIndex + imageCount)
        .map(filename => path.join(imageDir, filename));
}

function getImagesForCurrentSelection(imageCount = 4) {
    const selectedImages = getSelectedImagePaths();
    if (selectedImages.length > 0) {
        return {
            paths: selectedImages.slice(0, imageCount),
            usingSelectedImages: true,
            availableCount: selectedImages.length
        };
    }

    const legacyPaths = getLegacyQueuedImagePaths(imageCount);
    return {
        paths: legacyPaths,
        usingSelectedImages: false,
        availableCount: legacyPaths.length
    };
}

function clearSelectedImageFiles() {
    const selectedDir = getSelectedImagesDir();
    fs.mkdirSync(selectedDir, { recursive: true });
    for (const filename of fs.readdirSync(selectedDir)) {
        const fullPath = path.join(selectedDir, filename);
        if (fs.statSync(fullPath).isFile()) fs.unlinkSync(fullPath);
    }
}

// Directory Management
function ensureDirectories() {
    const dirs = [
        path.join(process.cwd(), 'images'),
        path.join(process.cwd(), '.wwebjs_auth'),
        path.join(process.cwd(), 'logs'),
        getSelectedImagesDir()
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
        console.log('CLIENT INITIALIZING');
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: 'my_custom_session',
                dataPath: path.join(process.cwd(), '.wwebjs_auth')
            }),
            puppeteer: {
                headless: false,
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
                console.log('QR GENERATED');
                const dataURL = await qrcode.toDataURL(qr);
                sendToRenderer('qr-code', dataURL);
            } catch (err) {
                console.error('QR Code generation error:', err);
                sendToRenderer('error', 'Failed to generate QR code');
            }
        });

        client.on('authenticated', () => {
            try {
                console.log('AUTHENTICATED');
                console.log('WAITING FOR READY');
                sendToRenderer('authenticated');
            } catch (err) {
                console.error('Error in authenticated handler:', err.stack || err.message);
            }
        });

        client.on('auth_failure', (msg) => {
            console.error('AUTH_FAILURE', msg);
            sendToRenderer('auth-failure', msg);
        });

        client.on('loading_screen', (percent) => {
            try {
                console.log('LOADING_SCREEN', percent);
            } catch (err) {
                console.error('Error in loading_screen handler:', err.stack || err.message);
            }
        });

        client.on('ready', () => {
            console.log('CLIENT READY');
            sendToRenderer('whatsapp-ready');
            console.log('WhatsApp client is ready!');
            fetchGroups();
        });

        client.on('disconnected', async (reason) => {
            console.log('DISCONNECTED', reason);
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
        console.error('Failed to initialize WhatsApp client:', error.stack || error.message);
        sendToRenderer('error', 'Failed to initialize WhatsApp');
        throw error;
    }
}
// Group Management
async function fetchGroups() {
    try {
        console.log('FETCHING CHATS');
        const chats = await client.getChats();
        console.log(`${Array.isArray(chats) ? chats.length : 0} CHATS RETURNED`);
        const groups = chats
            .filter(chat => chat.id._serialized.endsWith('@g.us'))
            .map(group => ({
                id: group.id._serialized,
                name: group.name
            }));

        console.log(`${Array.isArray(groups) ? groups.length : 0} GROUPS FOUND`);
        console.log('SENDING GROUPS TO UI');
        sendToRenderer('groups-loaded', groups);
    } catch (error) {
        console.error('fetchGroups failed:', error.stack || error.message);
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

        let usingSelectedImages = false;
        if (includeImages) {
            const imageSelection = getImagesForCurrentSelection(imageCount);
            imagesToSend = imageSelection.paths;
            usingSelectedImages = imageSelection.usingSelectedImages;

            if (imagesToSend.length === 0) {
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
                    for (const imagePath of imagesToSend) {
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

        if (successfulGroups > 0 && includeImages && !usingSelectedImages) {
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

// Campaign Management
class CampaignStoppedError extends Error {
    constructor() {
        super('Campaign stopped');
        this.name = 'CampaignStoppedError';
    }
}

function loadSentRecords() {
    try {
        if (!fs.existsSync(sentRecordsPath)) return [];
        const raw = fs.readFileSync(sentRecordsPath, 'utf8');
        if (!raw.trim()) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        logError(error, 'loadSentRecords');
        return [];
    }
}

function saveSentRecords(records) {
    try {
        fs.writeFileSync(sentRecordsPath, JSON.stringify(records, null, 2));
        return true;
    } catch (error) {
        logError(error, 'saveSentRecords');
        return false;
    }
}

function hashGroupId(groupId) {
    return crypto.createHash('sha256').update(String(groupId)).digest('hex');
}

function recordSentForGroup(groupId, campaignHash) {
    const records = loadSentRecords();
    const groupHash = hashGroupId(groupId);
    records.push({ groupHash, campaignHash, timestamp: Date.now() });
    if (records.length > 10000) {
        records.splice(0, records.length - 10000);
    }
    return saveSentRecords(records);
}

function isDuplicateCampaignForGroup(groupId, campaignHash, windowHours) {
    const records = loadSentRecords();
    const groupHash = hashGroupId(groupId);
    const cutoff = Date.now() - (windowHours * 60 * 60 * 1000);
    return records.some(record => {
        const sameGroup = record.groupHash === groupHash || record.groupId === groupId;
        return sameGroup && record.campaignHash === campaignHash && Number(record.timestamp) >= cutoff;
    });
}

function loadMessageHistory() {
    try {
        if (!fs.existsSync(messageHistoryPath)) return [];
        const raw = fs.readFileSync(messageHistoryPath, 'utf8');
        if (!raw.trim()) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        logError(error, 'loadMessageHistory');
        return [];
    }
}

function saveMessageHistory(records) {
    // Replace only after the full JSON has been written; preserve the old file on failure.
    const temporaryPath = messageHistoryPath + '.tmp';
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(records, null, 2));
        fs.renameSync(temporaryPath, messageHistoryPath);
        return true;
    } catch (error) {
        logError(error, 'saveMessageHistory');
        return false;
    } finally {
        try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch (_) {}
    }
}

function getSerializedMessageId(sentMessage) {
    if (!sentMessage || !sentMessage.id) return null;
    if (typeof sentMessage.id._serialized === 'string' && sentMessage.id._serialized) {
        return sentMessage.id._serialized;
    }
    if (typeof sentMessage.id.id === 'string' && sentMessage.id.id) {
        return sentMessage.id.id;
    }
    return null;
}

function recordMessageHistoryForGroup(campaignRunId, campaignHash, groupId, groupResult, displayInfo = {}) {
    const successfulImageIds = groupResult.imageResults
        .filter(image => image.success && image.messageId)
        .map(image => image.messageId);
    const textMessageId = groupResult.textSuccess ? groupResult.textMessageId : null;

    const successfulOperationCount =
        (groupResult.textSuccess ? 1 : 0) +
        groupResult.imageResults.filter(image => image.success).length;
    const capturedIdCount =
        (textMessageId ? 1 : 0) + successfulImageIds.length;

    if (successfulOperationCount === 0) {
        return { saved: true, recorded: false, missingIds: false };
    }

    const records = loadMessageHistory();
    records.push({
        campaignRunId,
        campaignHash,
        groupHash: hashGroupId(groupId),
        timestamp: Date.now(),
        status: groupResult.status,
        groupName: typeof displayInfo.groupName === 'string' ? displayInfo.groupName : '',
        messageText: typeof displayInfo.messageText === 'string' ? displayInfo.messageText : '',
        textMessageId,
        imageMessageIds: successfulImageIds
    });

    if (records.length > 5000) {
        records.splice(0, records.length - 5000);
    }

    return {
        saved: saveMessageHistory(records),
        recorded: true,
        missingIds: capturedIdCount < successfulOperationCount
    };
}

function getHistoryRecordId(record) {
    const signature = [
        record.campaignRunId || '',
        record.groupHash || '',
        record.timestamp || '',
        record.textMessageId || '',
        Array.isArray(record.imageMessageIds) ? record.imageMessageIds.join(',') : ''
    ].join('|');
    return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 24);
}

function findHistoryRecordById(records, historyId) {
    const index = records.findIndex(record => getHistoryRecordId(record) === historyId);
    return { index, record: index >= 0 ? records[index] : null };
}

async function getRecentMessageHistory(limit = 20) {
    const records = loadMessageHistory();
    const recent = records.slice(-Math.max(1, Math.min(50, Number(limit) || 20))).reverse();
    const entries = [];

    for (const record of recent) {
        let groupName = record.groupName || 'Previous send';
        let messageText = record.messageText || '';

        if (client && (!record.groupName || (!messageText && record.textMessageId))) {
            const probeId = record.textMessageId || (Array.isArray(record.imageMessageIds) ? record.imageMessageIds[0] : null);
            if (probeId) {
                try {
                    const sentMessage = await client.getMessageById(probeId);
                    if (sentMessage) {
                        if (record.textMessageId && sentMessage.body) messageText = sentMessage.body;
                        const chat = await sentMessage.getChat();
                        if (chat && chat.name) groupName = chat.name;
                    }
                } catch (error) {
                    logError(error, 'getRecentMessageHistory.lookup');
                }
            }
        }

        entries.push({
            historyId: getHistoryRecordId(record),
            timestamp: Number(record.timestamp) || 0,
            status: record.status || 'sent',
            groupName,
            messageText,
            hasText: !!record.textMessageId,
            imageCount: Array.isArray(record.imageMessageIds) ? record.imageMessageIds.filter(Boolean).length : 0,
            deleted: !!record.deletedAt,
            revokedCount: Array.isArray(record.revokedMessageIds) ? record.revokedMessageIds.length : 0,
            textDeleted: Array.isArray(record.revokedMessageIds) && record.revokedMessageIds.includes(record.textMessageId),
            editedAt: record.editedAt || null
        });
    }

    return entries;
}

async function editSentTextMessage(historyId, newText) {
    if (!client) throw new Error('WhatsApp client not initialized');
    const text = String(newText || '').trim();
    if (!text) throw new Error('Edited message cannot be empty.');

    const records = loadMessageHistory();
    const { index, record } = findHistoryRecordById(records, historyId);
    if (!record) throw new Error('Message history entry was not found.');
    if (record.deletedAt) throw new Error('This history entry was already deleted.');
    if (!record.textMessageId) throw new Error('This send does not contain an editable text message.');
    if (record.revokedMessageIds?.includes(record.textMessageId)) throw new Error('This text message was already deleted for everyone.');

    const sentMessage = await client.getMessageById(record.textMessageId);
    if (!sentMessage) throw new Error('WhatsApp could not find this message.');

    const edited = await sentMessage.edit(text);
    if (!edited) throw new Error('WhatsApp did not allow this message to be edited.');

    // Re-read after the network wait so new campaign history is not overwritten.
    const latestRecords = loadMessageHistory();
    const latest = findHistoryRecordById(latestRecords, historyId);
    if (!latest.record) throw new Error('WhatsApp operation succeeded, but local history could not be saved.');
    latest.record.messageText = text;
    latest.record.editedAt = Date.now();
    if (!saveMessageHistory(latestRecords)) throw new Error('WhatsApp operation succeeded, but local history could not be saved.');

    return true;
}

function safeHistoryError(error, messageIds = []) {
    let detail = String(error && error.message || error || 'Unknown WhatsApp error');
    for (const id of messageIds.filter(Boolean)) detail = detail.split(id).join('[message ID]');
    return detail.replace(/(?:true|false)_[^\s"'<>]+/g, '[message ID]')
        .replace(/\b[0-9]+(?:-[0-9]+)?@(?:g\.us|c\.us|s\.whatsapp\.net)\b/g, '[chat ID]')
        .replace(/\b[A-Fa-f0-9]{16,}\b/g, '[ID]');
}

async function getMessageRevokeCapability(messageId) {
    return client.pupPage.evaluate(async msgId => {
        const { Msg } = window.require('WAWebCollections');
        const msg = Msg.get(msgId) || (await Msg.getMessagesById([msgId]))?.messages?.[0];
        if (!msg) throw new Error('WhatsApp could not find this message.');
        if (msg.type === 'revoked') return { revoked: true, canRevoke: false };
        const capability = window.require('WAWebMsgActionCapability');
        return {
            revoked: false,
            canRevoke: !!(capability.canSenderRevokeMsg(msg) || capability.canAdminRevokeMsg(msg))
        };
    }, messageId);
}

async function deleteSentHistoryEntry(historyId) {
    if (!client) throw new Error('WhatsApp client not initialized');
    const { record } = findHistoryRecordById(loadMessageHistory(), historyId);
    if (!record) throw new Error('Message history entry was not found.');
    const result = { requested: 0, deletedForEveryone: 0, unavailable: 0, failed: 0,
        alreadyDeleted: !!record.deletedAt, historySaved: true, errors: [] };
    if (record.deletedAt) return result;

    const items = [
        { id: record.textMessageId, label: 'Text' },
        ...(Array.isArray(record.imageMessageIds) ? record.imageMessageIds : [])
            .map((id, index) => ({ id, label: 'Image ' + (index + 1) }))
    ].filter(item => item.id);
    if (!items.length) throw new Error('No WhatsApp message IDs were saved for this entry.');
    const revoked = new Set(record.revokedMessageIds || []);

    for (const { id, label } of items) {
        if (revoked.has(id)) continue; // A partial result must not repeat successful operations.
        try {
            const sentMessage = await client.getMessageById(id);
            if (!sentMessage) throw new Error('WhatsApp could not find this message.');
            const capability = await getMessageRevokeCapability(id);
            if (!capability.revoked) {
                if (!capability.canRevoke) {
                    result.unavailable += 1;
                    result.errors.push(label + ': Delete for everyone is no longer available for this message.');
                    continue;
                }
                result.requested += 1;
                await sentMessage.delete(true);
                // A resolved delete(true) alone does not establish a revoke.
                const after = await getMessageRevokeCapability(id);
                if (!after.revoked) throw new Error('Delete request completed, but deletion for everyone could not be verified. Check WhatsApp before trying again.');
            }
            revoked.add(id);
            result.deletedForEveryone += 1;
        } catch (error) {
            result.failed += 1;
            const detail = label + ': ' + safeHistoryError(error, items.map(item => item.id));
            result.errors.push(detail);
            logError(new Error(detail), 'deleteSentHistoryEntry.delete');
        }
    }

    // Merge only these confirmed item results into freshly loaded history.
    const latestRecords = loadMessageHistory();
    const latest = findHistoryRecordById(latestRecords, historyId);
    if (latest.record) {
        latest.record.revokedMessageIds = [...new Set([...(latest.record.revokedMessageIds || []), ...revoked])];
        latest.record.lastDeleteAttemptAt = Date.now();
        latest.record.lastDeleteResult = { requested: result.requested,
            deletedForEveryone: result.deletedForEveryone, unavailable: result.unavailable, failed: result.failed };
        if (items.every(item => latest.record.revokedMessageIds.includes(item.id))) {
            latest.record.deletedAt = Date.now();
        }
        result.historySaved = saveMessageHistory(latestRecords);
    } else {
        result.historySaved = false;
    }
    if (!result.historySaved) {
        result.error = result.deletedForEveryone > 0
            ? 'WhatsApp operation succeeded, but local history could not be saved.'
            : 'Local history could not be saved. Check WhatsApp for any requested operation; do not assume it failed or was rolled back.';
    }
    return result;
}

async function sendCampaignTextWithReceipt(groupId, message) {
    try {
        const sentMessage = await client.sendMessage(groupId, message);
        console.log(`Message sent to group ${groupId}`);
        await sleep(1000);
        return { success: true, messageId: getSerializedMessageId(sentMessage) };
    } catch (error) {
        console.error(`Failed to send message to group ${groupId}:`, error);
        return { success: false, messageId: null };
    }
}

async function sendCampaignMediaWithReceipt(groupId, media, delay = 2000) {
    try {
        const sentMessage = await client.sendMessage(groupId, media);
        await sleep(delay);
        return { success: true, messageId: getSerializedMessageId(sentMessage) };
    } catch (error) {
        console.error(`Failed to send media to group ${groupId}:`, error);
        return { success: false, messageId: null };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomIntInclusive(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function interruptibleWaitSeconds(totalSeconds, onTick) {
    let remaining = totalSeconds;
    while (remaining > 0) {
        if (campaignState.stopRequested) {
            throw new CampaignStoppedError();
        }
        if (campaignState.paused) {
            await sleep(500);
            continue;
        }
        await sleep(1000);
        remaining -= 1;
        if (typeof onTick === 'function') {
            onTick(remaining);
        }
    }
}

async function waitAfterProcessedGroup(processedCount, totalGroups, paceConfig) {
    if (processedCount >= totalGroups) return;

    const useLongPause = processedCount % paceConfig.pauseAfterGroups === 0;
    const seconds = useLongPause
        ? randomIntInclusive(paceConfig.pauseMin, paceConfig.pauseMax)
        : randomIntInclusive(paceConfig.minDelay, paceConfig.maxDelay);

    sendToRenderer('campaign-waiting', {
        remainingSeconds: seconds,
        longPause: useLongPause
    });

    await interruptibleWaitSeconds(seconds, remainingSeconds => {
        sendToRenderer('campaign-waiting', {
            remainingSeconds,
            longPause: useLongPause
        });
    });
}

async function sendSingleGroup(groupId, message, includeImages, imagesToSend, maxRetries) {
    const result = {
        status: 'failed',
        stopped: false,
        textSuccess: false,
        textAttempts: 0,
        textMessageId: null,
        imageResults: []
    };

    const textRequired = !!(message && message.trim());

    if (textRequired) {
        while (result.textAttempts <= maxRetries) {
            if (campaignState.stopRequested) {
                result.stopped = true;
                break;
            }

            result.textAttempts += 1;
            const receipt = await sendCampaignTextWithReceipt(groupId, message.trim());
            if (receipt.success) {
                result.textSuccess = true;
                result.textMessageId = receipt.messageId;
                break;
            }

            if (campaignState.stopRequested) {
                result.stopped = true;
                break;
            }
            if (result.textAttempts <= maxRetries) {
                await sleep(1000);
            }
        }
    }

    if (!result.stopped && includeImages && imagesToSend.length > 0) {
        for (let imageIndex = 0; imageIndex < imagesToSend.length; imageIndex++) {
            if (campaignState.stopRequested) {
                result.stopped = true;
                break;
            }

            const imageRef = imagesToSend[imageIndex];
            const imagePath = path.isAbsolute(imageRef)
                ? imageRef
                : path.join(process.cwd(), 'images', imageRef);
            let attempts = 0;
            let success = false;

            while (attempts <= maxRetries) {
                if (campaignState.stopRequested) {
                    result.stopped = true;
                    break;
                }

                attempts += 1;
                let messageId = null;
                try {
                    const media = MessageMedia.fromFilePath(imagePath);
                    const receipt = await sendCampaignMediaWithReceipt(groupId, media);
                    success = receipt.success;
                    messageId = receipt.messageId;
                } catch (error) {
                    logError(error, 'sendSingleGroup.media');
                    success = false;
                    messageId = null;
                }

                if (success) {
                    result.imageResults.push({
                        imageNumber: imageIndex + 1,
                        success: true,
                        attempts,
                        messageId
                    });
                    break;
                }
                if (campaignState.stopRequested) {
                    result.stopped = true;
                    break;
                }
                if (attempts <= maxRetries) {
                    await sleep(1000);
                }
            }

            if (!success) {
                result.imageResults.push({
                    imageNumber: imageIndex + 1,
                    success: false,
                    attempts,
                    messageId: null
                });
            }

            if (result.stopped) break;
        }
    }

    const imagesRequired = includeImages && imagesToSend.length > 0;
    const textComplete = !textRequired || result.textSuccess;
    const imagesComplete = !imagesRequired || (
        result.imageResults.length === imagesToSend.length &&
        result.imageResults.every(image => image.success)
    );
    const anyImageSuccess = imagesRequired && result.imageResults.some(image => image.success);
    const anySuccess = (textRequired && result.textSuccess) || anyImageSuccess;

    if (textComplete && imagesComplete) {
        result.status = 'sent';
    } else if (anySuccess) {
        result.status = 'partial';
    } else {
        result.status = 'failed';
    }

    return result;
}

async function sendCampaign(groupIdsParam, message, includeImages = true, imageCount = 4, options = {}) {
    const requestedImageCount = Number(imageCount);
    if (!Number.isInteger(requestedImageCount) || requestedImageCount < 0 || requestedImageCount > 4) {
        throw new Error('Image count must be an integer between 0 and 4.');
    }

    const shouldIncludeImages = !!(includeImages && requestedImageCount > 0);
    const normalizedMessage = (message || '').trim().replace(/\r\n/g, '\n');

    if (!normalizedMessage && !shouldIncludeImages) {
        throw new Error('Cannot start an empty campaign. Add a message or choose at least one image.');
    }

    const groupIds = Array.isArray(groupIdsParam) ? groupIdsParam.slice() : [groupIdsParam];
    if (groupIds.length === 0 || groupIds.some(groupId => !groupId)) {
        throw new Error('Select at least one WhatsApp group.');
    }
    if (groupIds.length > campaignDefaults.maxGroupsPerCampaign) {
        throw new Error(`Selected ${groupIds.length} groups. The campaign limit is ${campaignDefaults.maxGroupsPerCampaign}.`);
    }
    if (new Set(groupIds).size !== groupIds.length) {
        throw new Error('The selected group list contains duplicates.');
    }
    groupIds.forEach(groupId => validateGroupId(groupId));

    const dryRun = !!options.dryRun;
    const maxRetries = Math.min(
        campaignDefaults.maxRetries,
        Number.isInteger(Number(options.maxRetries)) ? Math.max(0, Number(options.maxRetries)) : campaignDefaults.maxRetries
    );
    const duplicateWindowHours = campaignDefaults.duplicateWindowHours;
    const paceConfig = { ...campaignDefaults.VERY_CAUTIOUS };

    let currentIndex = getCurrentIndex();
    let imagesToSend = [];
    let usingSelectedImages = false;
    const imageContentHashes = [];

    if (shouldIncludeImages) {
        const imageSelection = getImagesForCurrentSelection(requestedImageCount);
        imagesToSend = imageSelection.paths;
        usingSelectedImages = imageSelection.usingSelectedImages;

        if (imagesToSend.length !== requestedImageCount) {
            const sourceLabel = usingSelectedImages ? 'chosen images' : 'queued images';
            throw new Error(`Requested ${requestedImageCount} images, but only ${imagesToSend.length} ${sourceLabel} are available.`);
        }

        for (const imagePath of imagesToSend) {
            let imageBytes;
            try {
                imageBytes = fs.readFileSync(imagePath);
            } catch (error) {
                throw new Error(`One of the selected images could not be read: ${path.basename(imagePath)}`);
            }
            imageContentHashes.push(
                crypto.createHash('sha256').update(imageBytes).digest('hex')
            );
        }
    }

    const campaignSignature = JSON.stringify({
        message: normalizedMessage,
        images: imageContentHashes
    });
    const campaignHash = crypto.createHash('sha256').update(campaignSignature).digest('hex');
    const campaignRunId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');

    campaignState.running = true;
    campaignState.paused = false;
    campaignState.stopRequested = false;
    campaignState.currentIndex = 0;
    campaignState.totalGroups = groupIds.length;
    campaignState.progress = [];

    sendToRenderer('campaign-started', {
        totalGroups: groupIds.length,
        dryRun
    });

    let processed = 0;
    let sentCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let stopped = false;

    try {
        for (let index = 0; index < groupIds.length; index++) {
            if (campaignState.stopRequested) {
                stopped = true;
                break;
            }

            while (campaignState.paused) {
                await sleep(500);
                if (campaignState.stopRequested) {
                    stopped = true;
                    break;
                }
            }
            if (stopped || campaignState.stopRequested) {
                stopped = true;
                break;
            }

            const groupId = groupIds[index];
            processed += 1;
            campaignState.currentIndex = processed;

            let groupName = 'Selected group';
            try {
                const chat = await client.getChatById(groupId);
                if (chat && chat.name) groupName = chat.name;
            } catch (error) {
                logError(error, 'sendCampaign.getChatById');
            }

            if (isDuplicateCampaignForGroup(groupId, campaignHash, duplicateWindowHours)) {
                skippedCount += 1;
                campaignState.progress.push({ groupName, status: 'skipped' });
                sendToRenderer('duplicate-warning', {
                    index: processed,
                    total: groupIds.length,
                    groupName
                });
                sendToRenderer('campaign-progress', {
                    index: processed,
                    total: groupIds.length,
                    groupName,
                    status: 'skipped'
                });
            } else if (dryRun) {
                campaignState.progress.push({ groupName, status: 'dry-run' });
                sendToRenderer('campaign-progress', {
                    index: processed,
                    total: groupIds.length,
                    groupName,
                    status: 'dry-run'
                });
            } else {
                const groupResult = await sendSingleGroup(
                    groupId,
                    normalizedMessage,
                    shouldIncludeImages,
                    imagesToSend,
                    maxRetries
                );

                if (groupResult.status === 'sent') {
                    sentCount += 1;
                    if (!recordSentForGroup(groupId, campaignHash)) {
                        sendToRenderer('campaign-warning', 'Message sent, but duplicate-protection history could not be saved.');
                    }
                } else if (groupResult.status === 'partial') {
                    partialCount += 1;
                } else {
                    failedCount += 1;
                }

                const historyResult = recordMessageHistoryForGroup(
                    campaignRunId,
                    campaignHash,
                    groupId,
                    groupResult,
                    { groupName, messageText: normalizedMessage }
                );
                if (!historyResult.saved) {
                    sendToRenderer('campaign-warning', 'Message sent, but local message-ID history could not be saved.');
                } else if (historyResult.missingIds) {
                    sendToRenderer('campaign-warning', 'Message sent, but one or more WhatsApp message IDs could not be captured.');
                }

                logActivity({
                    groupName,
                    imageCount: shouldIncludeImages
                        ? groupResult.imageResults.filter(image => image.success).length
                        : 0,
                    message: !!normalizedMessage,
                    success: groupResult.status === 'sent',
                    status: groupResult.status
                });

                campaignState.progress.push({ groupName, status: groupResult.status });
                sendToRenderer('campaign-progress', {
                    index: processed,
                    total: groupIds.length,
                    groupName,
                    status: groupResult.status,
                    textAttempts: groupResult.textAttempts,
                    imageAttempts: groupResult.imageResults.map(image => ({
                        imageNumber: image.imageNumber,
                        attempts: image.attempts,
                        success: image.success
                    }))
                });

                if (groupResult.stopped || campaignState.stopRequested) {
                    stopped = true;
                    break;
                }
            }

            try {
                await waitAfterProcessedGroup(processed, groupIds.length, paceConfig);
            } catch (error) {
                if (error instanceof CampaignStoppedError) {
                    stopped = true;
                    break;
                }
                throw error;
            }
        }

        if (
            shouldIncludeImages &&
            !usingSelectedImages &&
            !dryRun &&
            !stopped &&
            partialCount === 0 &&
            failedCount === 0 &&
            sentCount > 0
        ) {
            try {
                currentIndex += imagesToSend.length;
                saveCurrentIndex(currentIndex);
            } catch (error) {
                logError(error, 'sendCampaign.saveCurrentIndex');
                sendToRenderer('campaign-warning', 'Campaign sent, but the local image queue position could not be saved.');
            }
        }

        const report = {
            totalGroups: groupIds.length,
            processed,
            sent: sentCount,
            partial: partialCount,
            failed: failedCount,
            skipped: skippedCount,
            dryRun,
            stopped
        };

        sendToRenderer('campaign-complete', report);
        return report;
    } finally {
        campaignState.running = false;
        campaignState.paused = false;
        campaignState.stopRequested = false;
        campaignState.currentIndex = 0;
        campaignState.totalGroups = 0;
    }
}

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

// Saved Group Preset
function loadSavedGroupIds() {
    try {
        if (!fs.existsSync(savedGroupsPath)) return [];
        const raw = fs.readFileSync(savedGroupsPath, 'utf8');
        if (!raw.trim()) return [];

        const parsed = JSON.parse(raw);
        const groupIds = Array.isArray(parsed) ? parsed : parsed.groupIds;
        if (!Array.isArray(groupIds)) return [];

        return [...new Set(groupIds)]
            .filter(groupId => typeof groupId === 'string' && groupId.endsWith('@g.us'))
            .slice(0, campaignDefaults.maxGroupsPerCampaign);
    } catch (error) {
        logError(error, 'loadSavedGroupIds');
        return [];
    }
}

function saveSavedGroupIds(groupIdsParam) {
    const groupIds = Array.isArray(groupIdsParam) ? groupIdsParam.slice() : [];
    if (groupIds.length === 0) {
        throw new Error('Select at least one group before saving the preset.');
    }
    if (groupIds.length > campaignDefaults.maxGroupsPerCampaign) {
        throw new Error(`You can save at most ${campaignDefaults.maxGroupsPerCampaign} groups.`);
    }
    if (new Set(groupIds).size !== groupIds.length) {
        throw new Error('The selected group list contains duplicates.');
    }

    groupIds.forEach(groupId => validateGroupId(groupId));
    fs.writeFileSync(savedGroupsPath, JSON.stringify({ groupIds }, null, 2));
    return groupIds.length;
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

ipcMain.on('start-campaign', async (event, { groupIds, message, imageCount = 4, options = {} }) => {
    try {
        if (!client) throw new Error('WhatsApp client not initialized');
        if (campaignState.running) throw new Error('A campaign is already running');

        const report = await sendCampaign(groupIds, message, true, imageCount, options);
        // campaign-complete will be emitted from sendCampaign
        return report;
    } catch (err) {
        logError(err, 'ipcMain.start-campaign');
        console.error('Error starting campaign:', err);
        sendToRenderer('campaign-error', err.message);
    }
});

ipcMain.on('pause-campaign', () => {
    if (!campaignState.running) return;
    campaignState.paused = true;
    sendToRenderer('campaign-paused');
});

ipcMain.on('resume-campaign', () => {
    if (!campaignState.running) return;
    campaignState.paused = false;
    sendToRenderer('campaign-resumed');
});

ipcMain.on('stop-campaign', () => {
    if (!campaignState.running) return;
    campaignState.stopRequested = true;
    sendToRenderer('campaign-stopping');
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

ipcMain.handle('get-saved-groups', async () => {
    return loadSavedGroupIds();
});

ipcMain.handle('save-selected-groups', async (event, groupIds) => {
    try {
        const savedCount = saveSavedGroupIds(groupIds);
        return { ok: true, savedCount };
    } catch (error) {
        logError(error, 'ipcMain.save-selected-groups');
        return { ok: false, error: error.message };
    }
});

ipcMain.handle('choose-images', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose up to 4 images',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }
            ]
        });

        if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
            return { ok: true, canceled: true };
        }
        if (result.filePaths.length > 4) {
            return { ok: false, error: 'Choose at most 4 images.' };
        }

        clearSelectedImageFiles();
        const selectedDir = getSelectedImagesDir();
        result.filePaths.forEach((sourcePath, index) => {
            const extension = path.extname(sourcePath).toLowerCase();
            if (!supportedImageExtensions.has(extension)) {
                throw new Error(`Unsupported image type: ${path.basename(sourcePath)}`);
            }
            const destination = path.join(selectedDir, `${index + 1}${extension}`);
            fs.copyFileSync(sourcePath, destination);
        });

        return {
            ok: true,
            canceled: false,
            count: result.filePaths.length,
            files: getSelectedImagePaths().map(filePath => filePath.replace(/\\/g, '/'))
        };
    } catch (error) {
        logError(error, 'ipcMain.choose-images');
        return { ok: false, error: error.message };
    }
});

ipcMain.handle('clear-chosen-images', async () => {
    try {
        clearSelectedImageFiles();
        return { ok: true };
    } catch (error) {
        logError(error, 'ipcMain.clear-chosen-images');
        return { ok: false, error: error.message };
    }
});

ipcMain.handle('get-chosen-images-info', async () => {
    try {
        const files = getSelectedImagePaths();
        return { active: files.length > 0, count: files.length };
    } catch (error) {
        logError(error, 'ipcMain.get-chosen-images-info');
        return { active: false, count: 0 };
    }
});

ipcMain.handle('get-sent-message-history', async (event, limit = 20) => {
    try {
        return { ok: true, entries: await getRecentMessageHistory(limit) };
    } catch (error) {
        logError(error, 'ipcMain.get-sent-message-history');
        return { ok: false, error: error.message, entries: [] };
    }
});

let historyOperationBusy = false;

ipcMain.handle('edit-sent-text', async (event, payload = {}) => {
    if (historyOperationBusy) return { ok: false, error: 'Another history operation is still running.' };
    historyOperationBusy = true;
    try {
        await editSentTextMessage(payload.historyId, payload.newText);
        return { ok: true };
    } catch (error) {
        const detail = safeHistoryError(error);
        logError(new Error(detail), 'ipcMain.edit-sent-text');
        return { ok: false, error: detail };
    } finally {
        historyOperationBusy = false;
    }
});

ipcMain.handle('delete-sent-entry', async (event, payload = {}) => {
    if (historyOperationBusy) return { ok: false, error: 'Another history operation is still running.' };
    historyOperationBusy = true;
    try {
        const result = await deleteSentHistoryEntry(payload.historyId);
        return { ok: result.failed === 0 && result.unavailable === 0 && result.historySaved, ...result };
    } catch (error) {
        const detail = safeHistoryError(error);
        logError(new Error(detail), 'ipcMain.delete-sent-entry');
        return { ok: false, error: detail, requested: 0, deletedForEveryone: 0, unavailable: 0, failed: 1 };
    } finally {
        historyOperationBusy = false;
    }
});

ipcMain.handle('get-image-queue', async () => {
    try {
        const imageSelection = getImagesForCurrentSelection(4);
        return imageSelection.paths.map(filePath => filePath.replace(/\\/g, '/'));
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

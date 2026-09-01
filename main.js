const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const isDev = require('electron-is-dev');
const EncryptedStorage = require('./EncryptedStorage.js');
let JSONdb = require('simple-json-db');
const axios = require('axios').default;
const User = require('steam-user');
const SteamTotp = require('steam-totp');
const fs = require('fs');
const path = require('path');
const { EOL } = require('os');
const { penalty_reason_string, protoDecode, protoEncode, penalty_reason_permanent } = require('./helpers/util.js');
const { parseMatchmaking, parseAccountMain, looksLikeGcpdPage, looksLikeLoginPage, looksLikeErrorPage, extractCompetitiveMaps } = require('./helpers/gcpd_parser.js');
const { mergeGcpdMatchmaking, applyGcRanking, applyGcRankUpdateEntry } = require('./helpers/rankMerge.js');
const logger = require('./helpers/logger.js');
const { parseAccountLines } = require('./helpers/importParser.js');
const { TaskQueue } = require('./helpers/queue.js');
const { STATUS, statusFromEresult, shouldRetry, backoffDelay } = require('./helpers/checker.js');
const { xpIntoLevel, xpModuloLevel } = require('./helpers/xp.js');
// Исправление загрузки proto-файлов
let Protos;
try {
    logger.info('Loading proto files for csgo...');
    const protoFiles = [
        path.join(__dirname, '/protos/cstrike15_gcmessages.proto'),
        path.join(__dirname, '/protos/gcsdk_gcmessages.proto'),
        path.join(__dirname, '/protos/base_gcmessages.proto')
    ];
    
    // Проверяем существование файлов
    protoFiles.forEach((file, index) => {
        if (fs.existsSync(file)) {
            logger.debug('Found proto file', { index: index + 1, file });
        } else {
            logger.error('Proto file not found', { file });
        }
    });
    
    Protos = require('./helpers/protos.js')([{
        name: 'csgo',
        protos: protoFiles
    }]);
    logger.info('Proto files loaded successfully');
} catch (error) {
    logger.error('Error loading proto files', { error });
    Protos = { csgo: {} }; // Пустой объект для предотвращения ошибок
}

// GC protocol constants (from gc_emsg.hpp in reference project)
// NOTE: GC_HELLO_VERSION corresponds to the CS2 client version. Valve increments this
// with game updates. If it falls too far behind, the GC may reject the hello or return
// incomplete data. Update this value when Valve releases new CS2 client versions.
const GC_HELLO_VERSION = 2000244;
const GC_HELLO_RETRY_INTERVAL = 1500; // ms between hello retries
const GC_HELLO_MAX_ATTEMPTS = 10;
const GC_MSG = {
    ClientWelcome: 4004,
    ClientHello: 4006,
    MatchmakingClient2GCHello: 9109,
    MatchmakingGC2ClientHello: 9110,
    RequestPlayersProfile: 9127,
    PlayersProfile: 9128,
    ClientGCRankUpdate: 9194
};

// Retry policy for account checks. invalid_credentials and steam_guard_required
// fail fast (see helpers/checker.js shouldRetry); everything else is retried
// with exponential backoff + jitter up to CHECK_MAX_ATTEMPTS.
const CHECK_MAX_ATTEMPTS = 3;
const DEFAULT_CHECK_CONCURRENCY = 3;

/**
 * Apply parsed GCPD accountmain data (level, XP, prime) onto the in-flight
 * check data object and persist level/xp/prime onto the stored account.
 * XP conversion uses xpIntoLevel from helpers/xp.js, where the single CS2 XP
 * base constant lives.
 * @param {object} data In-flight check data (mutated)
 * @param {string} accountMainHtml Raw GCPD accountmain HTML
 * @param {string} username Account login
 * @param {object} db simple-json-db instance
 * @param {Electron.BrowserWindow|null} win Renderer window or null
 */
function applyAccountMainData(data, accountMainHtml, username, db, win) {
    const accountData = parseAccountMain(accountMainHtml);
    if (!accountData.ok) return;

    if (accountData.cs2_player_level >= 0) {
        data.lvl = accountData.cs2_player_level;
    }
    if (accountData.cs2_player_xp >= 0) {
        // Convert raw absolute XP to XP-within-level if it looks like a raw
        // value; leave in-level values unchanged. The CS2 XP base lives in
        // exactly one place (helpers/xp.js) so it is never duplicated here.
        data.exp = xpIntoLevel(accountData.cs2_player_xp);
    }

    data.prime = (data.lvl > 1) || (data.exp > 0);
    const account = db.get(username);
    if (account) {
        if (data.lvl) account.lvl = data.lvl;
        if (data.exp) account.exp = data.exp;
        account.prime = data.prime;
        db.set(username, account);
        if (win) win.webContents.send('accounts:updated', { login: username, data: account });
    }
}

/**
 * Apply parsed GCPD matchmaking data (ranks, wins, maps, last game) onto the
 * in-flight check data object. GCPD is only a gap-filler for ranks; the GC
 * handlers remain authoritative (see helpers/rankMerge.js).
 * @param {object} data In-flight check data (mutated)
 * @param {string} matchmakingHtml Raw GCPD matchmaking HTML
 * @param {string} username Account login
 */
function applyMatchmakingData(data, matchmakingHtml, username) {
    const mmData = parseMatchmaking(matchmakingHtml);
    if (mmData.ok) {
        // GCPD is a GAP-FILLER for ranks: the GC handlers (PlayersProfile
        // 9128 / ClientGCRankUpdate 9194) are authoritative for rank ids.
        // mergeGcpdMatchmaking never clobbers a VAC/ban sentinel (-1), only
        // writes when GCPD actually has signal for the mode, and maps expired
        // premier -> -1 / expired wingman -> rank 0 with wins retained.
        // See helpers/rankMerge.js.
        mergeGcpdMatchmaking(data, mmData);
        logger.debug('GCPD matchmaking resolved', {
            account: username,
            rank_premier: data.rank_premier,
            wins_premier: data.wins_premier,
            rank_wg: data.rank_wg,
            wins_wg: data.wins_wg
        });
    }

    data.maps = extractCompetitiveMaps(matchmakingHtml);
    const lastGameMatch = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT)/.exec(matchmakingHtml);
    if (lastGameMatch) {
        data.last_game = new Date(lastGameMatch[1]);
    }
}

/**
 * Resolve the configured concurrency for mass checks, defaulting to 3.
 * @returns {number}
 */
function getCheckConcurrency() {
    const configured = Number(settings.get('checkConcurrency'));
    if (Number.isFinite(configured) && configured >= 1) {
        return Math.floor(configured);
    }
    return DEFAULT_CHECK_CONCURRENCY;
}

// Shared bounded-concurrency queue for mass operations (import auto-check,
// refresh-all). Rebuilt when the configured concurrency changes so at most
// `concurrency` steam-user logons happen at once.
let checkQueue = null;

/**
 * Get (or lazily build) the shared mass-check queue at the configured
 * concurrency. Rebuilds if the setting changed since last use.
 * @returns {TaskQueue}
 */
function getCheckQueue() {
    const concurrency = getCheckConcurrency();
    if (!checkQueue || checkQueue.concurrency !== concurrency) {
        checkQueue = new TaskQueue(concurrency);
    }
    return checkQueue;
}

const browserWindowOptions = {
    webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: false,
    },
};

if (process.platform === "linux") {
    browserWindowOptions.icon = path.join(`${__dirname}/icons/icon.png`);
}

const IS_PORTABLE = process.env.PORTABLE_EXECUTABLE_DIR != null;
const USER_DATA = IS_PORTABLE ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, process.env.PORTABLE_EXECUTABLE_APP_FILENAME + '-data') : app.getPath('userData');
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json');
const ACCOUNTS_PATH = path.join(USER_DATA, 'accounts.json');
const ACCOUNTS_ENCRYPTED_PATH = path.join(USER_DATA, 'accounts.encrypted.json');

if(!fs.existsSync(USER_DATA)){
    fs.mkdirSync(USER_DATA) //makes data on first run
}

if (isDev) {
    try {
        require('electron-reload')(__dirname);
    } catch (_) { }
}

let steamTimeOffset = null;

let win = null

let passwordPromptResponse = null;

const settings = new JSONdb(SETTINGS_PATH);
settings.sync(); //makes empty file on first run

//will be initialized later
/**
 * @type {JSONdb}
 */
var db = null;

/**
 * Apply defensive navigation guards to a BrowserWindow's webContents. Denies
 * in-page navigation to anything other than the file that is already loaded
 * (our bundled html), and refuses to open new windows for anything other than
 * http/https links, which are instead handed off to the OS browser via
 * shell.openExternal. This keeps the renderer from being redirected to, or
 * spawning, arbitrary external/file:// content even if markup is compromised.
 * @param {Electron.WebContents} webContents
 */
function applyNavigationGuards(webContents) {
    webContents.on('will-navigate', (event, url) => {
        const current = webContents.getURL();
        // Allow navigations that stay on the currently loaded document
        // (e.g. in-page reloads / hash changes). Deny everything else.
        if (url !== current) {
            event.preventDefault();
            logger.warn('Blocked navigation attempt', { op: 'security', url });
        }
    });

    webContents.setWindowOpenHandler(({ url }) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (_) {
            logger.warn('Blocked window open with invalid url', { op: 'security', url });
            return { action: 'deny' };
        }
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            shell.openExternal(url).catch((err) => {
                logger.error('Failed to open external url', { op: 'security', error: err });
            });
        } else {
            logger.warn('Blocked window open for non-http scheme', { op: 'security', scheme: parsed.protocol });
        }
        // Never let the renderer open a new Electron window itself.
        return { action: 'deny' };
    });
}

function beforeWindowInputHandler(window, event, input) {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        window.webContents.openDevTools();
        event.preventDefault();
    }
    if (input.control && input.key.toLowerCase() === 'r') {
        window.reload();
    }
}

/**
 * Show the password prompt window and resolve with the entered password.
 * Preserves the original behavior: quits the app if the window is closed
 * without a response, and passes the last error message to the dialog.
 * @param {string|null} error_message previous error to display, if any
 * @returns {Promise<string>}
 */
function promptForPassword(error_message) {
    return new Promise((resolve, reject) => {
        passwordPromptResponse = null;
        let promptWindow = new BrowserWindow({
            ...browserWindowOptions,
            width: 500,
            height: 280,
            resizable: false,
            show: false
        });
        promptWindow.removeMenu();
        applyNavigationGuards(promptWindow.webContents);
        promptWindow.loadFile(__dirname + '/html/password.html').then(() => {
            promptWindow.webContents.send('password_dialog:init', error_message);
        })
        promptWindow.webContents.on('before-input-event', (event, input) => beforeWindowInputHandler(promptWindow, event, input));
        promptWindow.once('ready-to-show', () => promptWindow.show())
        promptWindow.on('closed', () => {
            if (passwordPromptResponse == null) {
                return app.quit();
            }
            resolve(passwordPromptResponse);
            promptWindow = null;
        })
        promptWindow.webContents.on('render-process-gone', (event, detailed) => {
          console.error("render crashed, reason: " + detailed.reason + ", exitCode = " + detailed.exitCode)
        });
    });
}

/**
 * Open the encrypted account DB with the given password, resolving once it is
 * loaded and rejecting on any (sync or async) decryption error.
 * @param {string} pass
 * @returns {Promise<EncryptedStorage>}
 */
function openEncryptedDb(pass) {
    return new Promise((res, rej) => {
        try {
            let db = new EncryptedStorage(ACCOUNTS_ENCRYPTED_PATH, pass);
            db.on('error', rej);//this is for async errors
            db.on('loaded', () => res(db));
        } catch (error) {
            rej(error);
        }
    });
}

/**
 * Normalize a decrypt/open error into the human-readable string the password
 * dialog displays, preserving the original mapping (BAD_DECRYPT -> "Invalid
 * password", error.code, else stringified). String errors pass through.
 * @param {*} error
 * @returns {string}
 */
function normalizeDecryptError(error) {
    if (typeof error != 'string') {
        if (error.reason == 'BAD_DECRYPT') {
            return 'Invalid password';
        }
        else if (error.code) {
            return error.code;
        }
        else {
            return error.toString();
        }
    }
    return error;
}

async function openDB() {
    try {
        if (db) {
            db.sync(); //force save before switch
            db = null;
        }
        if (settings.get('encrypted')) {
            let error_message = null;
            while (true) {
                let pass = await promptForPassword(error_message);
                try {
                    if (pass == null || pass.length === 0) {
                        throw 'Password can not be empty';
                    }
                    db = await openEncryptedDb(pass);
                    //we decrypted successfully, exit loop
                    break;
                } catch (error) {
                    error_message = normalizeDecryptError(error);
                }
            }
            return;
        }
        db = new JSONdb(ACCOUNTS_PATH);
        db.sync();
    } catch (error) {
        await dialog.showMessageBox(null, {
            title: 'openDB Error',
            message: error.toString(),
            type: 'error'
        });
    }
}

// add some defaults
if (!settings.get('tags')) {
    settings.set('tags', {
        'good trust': '#00CC00',
        'yellow trust': '#ffCC00',
        'red trust': '#CC0000',
        'for sale': '#0066FF',
        'example tag': '#FF3399'
    });
}
if (typeof settings.get('encrypted') != 'boolean') {
    settings.set('encrypted', false);
}

let updated = settings.get('version') != app.getVersion();
settings.set('version', app.getVersion());

var currently_checking = [];

var mainWindowCreated = false;

/**
 * Remove a username from the currently_checking list. Centralised so every
 * finish/error/disconnect path cleans up consistently and no account gets
 * stuck marked 'pending'.
 * @param {string} username
 */
function clearCurrentlyChecking(username) {
    currently_checking = currently_checking.filter(x => x !== username);
}

/**
 * Persist an account's status (new backward-compatible field) and notify the
 * renderer. Never removes existing fields. No-op if the account is gone.
 * @param {string} username
 * @param {string} status one of STATUS.*
 */
function setAccountStatus(username, status) {
    if (!db) return;
    const account = db.get(username);
    if (!account) return;
    account.status = status;
    db.set(username, account);
    if (win) {
        win.webContents.send('accounts:updated', { login: username, data: account });
    }
}

function createWindow () {

    win = new BrowserWindow({
        ...browserWindowOptions,
        
        width: 1100,
        height: 650,
        minWidth: 1100,
        minHeight: 625
    });
    win.removeMenu();
    applyNavigationGuards(win.webContents);
    win.loadFile(__dirname + '/html/index.html');
    win.webContents.on('before-input-event', (event, input) => beforeWindowInputHandler(win, event, input));
    win.webContents.once('did-finish-load', () => {
        // disable automatic downloads in portable mode
        autoUpdater.autoDownload = !IS_PORTABLE && !isDev;
        autoUpdater.on('update-available', (info) => {
            const { provider } = autoUpdater.updateInfoAndProvider;
            const updateUrl = provider.baseUrl + provider.options.owner + '/' + provider.options.repo + '/releases/latest';
            win.webContents.send('update:available', autoUpdater.autoDownload, updateUrl);
        });
        autoUpdater.on('update-downloaded', (info) => {
            win.webContents.send('update:downloaded');
        });
        autoUpdater.on('error', (err) => {
            logger.error('Auto updater error', { op: 'autoupdate', error: err });
        });
        if (autoUpdater.autoDownload) {
            autoUpdater.checkForUpdatesAndNotify();
        }
        else {
            autoUpdater.checkForUpdates();
        }
    });
    win.webContents.on('render-process-gone', (event, detailed) => {
      console.error("render crashed, reason: " + detailed.reason + ", exitCode = " + detailed.exitCode)
    });

    mainWindowCreated = true;
}

app.whenReady().then(async () => {
    await openDB();
    createWindow();
})

app.on('window-all-closed', () => {
    if (!mainWindowCreated) {
        return;
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
})

ipcMain.on('encryption:password', (_, password) => passwordPromptResponse = password);

ipcMain.handle('encryption:setup', async () => {
    let pass = await new Promise((resolve, reject) => {
        passwordPromptResponse = null;
        let promptWindow = new BrowserWindow({
            ...browserWindowOptions,
            parent: win,
            modal: true,
            width: 500,
            height: 375,
            resizable: false,
            show: false
        });
        promptWindow.removeMenu();
        applyNavigationGuards(promptWindow.webContents);
        promptWindow.loadFile(__dirname + '/html/encryption_setup.html');
        promptWindow.webContents.on('before-input-event', (event, input) => beforeWindowInputHandler(promptWindow, event, input));
        promptWindow.once('ready-to-show', () => promptWindow.show())
        promptWindow.on('closed', () => {
            if (passwordPromptResponse == null) {
                resolve(null);
            }
            resolve(passwordPromptResponse);
            promptWindow = null;
        })
        promptWindow.webContents.on('render-process-gone', (event, detailed) => {
          console.error("render crashed, reason: " + detailed.reason + ", exitCode = " + detailed.exitCode)
        });
    });
    if (pass == null) { //no data submitted
        return false;
    }
    try {
        db = await new Promise((res, rej) => {
            try {
                let new_db = new EncryptedStorage(ACCOUNTS_ENCRYPTED_PATH, pass, {
                    newData: db.JSON()
                });
                new_db.on('error', rej);//this is for async errors
                new_db.on('loaded', () => res(new_db));
            } catch (error) {
                rej(error);
            }
        });
        //delete plain text file
        fs.unlinkSync(ACCOUNTS_PATH);
        settings.set('encrypted', true);
        return true;
    } catch (error) {
        logger.error('Failed to enable encryption', { op: 'encrypt', error });
        return false;
    }
});

ipcMain.handle('steamtotp', (_, data) => new Promise((resolve, reject) =>{
    SteamTotp.generateAuthCode(data.secret, (err, code) => {
        if (err) {
            console.error("err, " + err)
            reject(err);
            return;
        }
        resolve(code);
    })
}))

ipcMain.handle('encryption:remove', async () => {
    let error_message = null;
    while (true) {
        let pass = await new Promise((resolve, reject) => {
            passwordPromptResponse = null;
            let promptWindow = new BrowserWindow({
                ...browserWindowOptions,
                parent: win,
                modal: true,
                width: 500,
                height: 280,
                resizable: false,
                show: false
            });
            promptWindow.removeMenu();
            applyNavigationGuards(promptWindow.webContents);
            promptWindow.loadFile(__dirname + '/html/password.html').then(() => {
                promptWindow.webContents.send('password_dialog:init', error_message, 'Remove encryption');
            })
            promptWindow.webContents.on('before-input-event', (event, input) => beforeWindowInputHandler(promptWindow, event, input));
            promptWindow.once('ready-to-show', () => promptWindow.show())
            promptWindow.on('closed', () => {
                if (passwordPromptResponse == null) {
                    resolve(null);
                }
                resolve(passwordPromptResponse);
                promptWindow = null;
            })
            promptWindow.webContents.on('render-process-gone', (event, detailed) => {
              console.error("render crashed, reason: " + detailed.reason + ", exitCode = " + detailed.exitCode)
            });
        });
        if (pass == null) { //no data submitted
            return true; //true is fail as we are still encrypted
        }
        try {
            if (pass.length == 0) {
                throw 'Password can not be empty';
            }
            //attempt to decrypt using this password
            let temp_db = await new Promise((res, rej) => {
                try {
                    let new_db = new EncryptedStorage(ACCOUNTS_ENCRYPTED_PATH, pass);
                    new_db.on('error', rej);//this is for async errors
                    new_db.on('loaded', () => res(new_db));
                } catch (error) {
                    rej(error);
                }
            });
            db = new JSONdb(ACCOUNTS_PATH);
            db.JSON(temp_db.JSON());
            db.sync();

            temp_db = null;

            //delete encrypted file
            fs.unlinkSync(ACCOUNTS_ENCRYPTED_PATH);
            settings.set('encrypted', false);
            return false; //false is success as in non encrypted
        } catch (error) {
            logger.error('Failed to disable encryption', { op: 'decrypt', error });
            if (typeof error != 'string') {
                if (error.reason == 'BAD_DECRYPT') {
                    error = 'Invalid password';
                }
                else if (error.code) {
                    error = error.code;
                }
                else {
                    error = error.toString();
                }
            }
            error_message = error;
        }
    }
});

ipcMain.handle('app:version', app.getVersion);

ipcMain.handle('accounts:get', () => {
    let data = db.JSON();
    for (const username in data) {
        if (Object.hasOwnProperty.call(data, username)) {
            const account = data[username];
            if(currently_checking.indexOf(username) != -1){
                account.pending = true;
            }
        }
    }
    return data;
});

// Human-readable strings for the steam-user login error eresults we recognize.
// eresults 6 and 34 both map to "Logged In Elsewhere".
const LOGIN_ERROR_STRINGS = {
    2: 'General Failure',
    5: 'Invalid Password',
    6: 'Logged In Elsewhere',
    34: 'Logged In Elsewhere',
    18: 'Expired',
    65: 'steam guard is invalid',
    84: 'Rate Limit Exceeded'
};

/**
 * Map a steam-user login error eresult to a human-readable string, preserving
 * the exact wording (and the Unknown fallback) of the original switch.
 * @param {number} eresult
 * @returns {string}
 */
function loginErrorString(eresult) {
    return LOGIN_ERROR_STRINGS[eresult] ?? `Unknown: ${eresult}`;
}

// Rank/wins fields normalized from null back to 0 on finish for UI backward
// compatibility (the renderer expects numbers, not null).
const RANK_NULLABLE_FIELDS = [
    'rank', 'wins',
    'rank_wg', 'wins_wg',
    'rank_dz', 'wins_dz',
    'rank_premier', 'wins_premier'
];

/**
 * Convert any null/undefined rank/wins fields on a resolved data object back to
 * 0, in place. Uses `== null` so only null/undefined (not a legitimate 0 or the
 * -1 VAC/expired sentinel) are replaced.
 * @param {object} resolveData
 */
function normalizeRankNulls(resolveData) {
    for (const field of RANK_NULLABLE_FIELDS) {
        if (resolveData[field] == null) resolveData[field] = 0;
    }
}

/**
 * Derive a STATUS from a check_account rejection. The rejection carries an
 * `eresult` when it originated from a steam-user login error; otherwise it is a
 * generic/transient error.
 * @param {*} error
 * @returns {string} a STATUS value
 */
function statusFromCheckError(error) {
    if (error && typeof error === 'object' && error.eresult != null) {
        return statusFromEresult(error.eresult);
    }
    return STATUS.ERROR;
}

/**
 * Extract a human-readable message from a check_account rejection while
 * preserving backward compatibility with the string errors the UI expects.
 * @param {*} error
 * @returns {string}
 */
function checkErrorMessage(error) {
    if (error == null) return 'unknown error';
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error.message) return String(error.message);
    return String(error);
}

/**
 * Run a single account check with retry + exponential backoff + jitter and a
 * hard attempt cap. Non-retryable outcomes (invalid_credentials,
 * steam_guard_required) fail fast; rate_limited backs off longer. Never loops
 * forever. Writes the result and a per-account status to the db.
 * @param {string} username
 * @returns {Promise<object>} the resolved data object, or { error, status }
 */
function saveAccountCheckSuccess(username, account, res) {
    const current = db.get(username) || account;
    for (const key in res) {
        if (Object.hasOwnProperty.call(res, key)) {
            current[key] = res[key];
        }
    }
    current.status = STATUS.SUCCESS;
    db.set(username, current);
    if (win) win.webContents.send('accounts:updated', { login: username, data: current });
}

function saveAccountCheckFailure(username, account, lastStatus, lastError) {
    logger.error('Account check failed', { account: username, op: 'check', status: lastStatus, error: lastError });
    const message = checkErrorMessage(lastError);
    const current = db.get(username) || account;
    current.error = message;
    current.status = lastStatus;
    db.set(username, current);
    if (win) win.webContents.send('accounts:updated', { login: username, data: current });
    return { error: message, status: lastStatus };
}

/**
 * Check an account with automatic retry and exponential backoff.
 * @param {string} username login
 * @returns {Promise<object>}
 */
async function process_check_account(username) {
    const account = db.get(username);
    if (!account) {
        return { error: 'unable to find account' };
    }

    setAccountStatus(username, STATUS.CHECKING);
    let lastError = null;
    let lastStatus = STATUS.ERROR;

    for (let attempt = 1; attempt <= CHECK_MAX_ATTEMPTS; attempt++) {
        try {
            const res = await check_account(username, account.password, account.sharedSecret);
            logger.debug('Account check completed', { account: username, op: 'check', attempt });
            saveAccountCheckSuccess(username, account, res);
            return res;
        } catch (error) {
            lastError = error;
            lastStatus = statusFromCheckError(error);
            logger.warn('Account check attempt failed', {
                account: username, op: 'check', attempt, status: lastStatus, error
            });

            if (shouldRetry({ attempt, maxAttempts: CHECK_MAX_ATTEMPTS, status: lastStatus })) {
                const delay = backoffDelay({ attempt, status: lastStatus });
                setAccountStatus(username, lastStatus);
                await new Promise(p => setTimeout(p, delay));
                continue;
            }
            break;
        }
    }

    return saveAccountCheckFailure(username, account, lastStatus, lastError);
}

ipcMain.handle('ready', () => {
    if (win && updated) {
        win.webContents.send('update:changelog', fs.readFileSync(__dirname + '/changelog.md').toString());
    }
});

ipcMain.handle('accounts:check', async (_, username) => await process_check_account(username));

ipcMain.handle('accounts:add', (_, username, password) => db.set(username, { password: password }));

ipcMain.handle('accounts:update', (_, username, data) => {
    let account = db.get(username);
    for (const key in data) {
        account[key] = data[key];
    }
    db.set(username, account);
});

ipcMain.handle('accounts:delete', (_, username) => db.delete(username));

ipcMain.handle('accounts:delete_all', (_) => db.deleteAll());

ipcMain.handle('accounts:import', async (event) => {
    let file = await dialog.showOpenDialog(event.sender, { properties: ['openFile'], });
    if (file.canceled) {
        return;
    }
    file = file.filePaths[0];
    const { accounts, skipped } = parseAccountLines(fs.readFileSync(file).toString());
    accounts.forEach(acc => {
        const existing = db.get(acc.username);
        const entry = existing ? { ...existing } : {};
        entry.password = acc.password;
        // Preserve an existing shared secret when the imported line omits one.
        if (acc.sharedSecret) {
            entry.sharedSecret = acc.sharedSecret;
        }
        db.set(acc.username, entry);
    });
    logger.info('Imported accounts', { op: 'import', imported: accounts.length, skipped });
    // Route auto-checks through the bounded queue so at most `concurrency`
    // steam-user logons happen at once instead of unbounded fire-and-forget.
    const queue = getCheckQueue();
    for (const acc of accounts) {
        queue.add(() => process_check_account(acc.username)).catch((err) => {
            logger.error('Queued import check failed', { account: acc.username, op: 'import', error: err });
        });
    }
    // Do not block the handler on the whole batch; the queue runs async and the
    // renderer is updated per-account via 'accounts:updated'.
});

// Refresh-all path: check every stored account through the bounded queue.
ipcMain.handle('accounts:check_all', () => {
    const queue = getCheckQueue();
    const usernames = Object.keys(db.JSON());
    for (const username of usernames) {
        queue.add(() => process_check_account(username)).catch((err) => {
            logger.error('Queued refresh check failed', { account: username, op: 'refresh', error: err });
        });
    }
    return usernames.length;
});

ipcMain.handle('accounts:export', async (event) => {
    let file = await dialog.showSaveDialog({
        defaultPath: 'accounts.txt',
        filters: [
            {
                name: 'Text files',
                extensions: ['txt']
            },
            { 
                name: 'All Files', 
                extensions: ['*'] 
            }
        ]
    });
    if (file.canceled) {
        return;
    }
    let accs = Object.entries(db.JSON()).map(([username, data]) => {
        const line = username + ':' + data.password;
        return data.sharedSecret ? line + ':' + data.sharedSecret : line;
    }).join(EOL);
    fs.writeFileSync(file.filePath, accs);
});

ipcMain.handle("settings:get", (_, type) => settings.get(type));

ipcMain.handle("settings:set", (_, type, value) => settings.set(type, value));

/**
 * Logs on to specified account and performs all checks
 * @param {string} username login
 * @param {string} pass password
 * @param {string} [sharedSecret] mobile authenticator shared secret
 * @returns {Promise}
 */
function check_account(username, pass, sharedSecret) {
    return new Promise((resolve, reject) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        currently_checking.push(username);
        setAccountStatus(username, STATUS.LOGGING_IN);

        let Done = false;
        let attempts = 0;
        let gcHelloInterval = null;
        let gcHelloAttempts = 0;
        let gcWelcomeReceived = false;
        let gcRankDataReady = false;
        let steamClient = new User();

        // Steam Guard IPC listener registered for THIS check (if the renderer
        // is prompted). Tracked here so every terminal path can tear it down;
        // otherwise a listener registered for an account that keeps hitting
        // Steam Guard would outlive its check and accumulate across retries.
        let steamGuardResponseHandler = null;
        function removeSteamGuardListener() {
            if (steamGuardResponseHandler) {
                ipcMain.removeListener('steam:steamguard:response', steamGuardResponseHandler);
                steamGuardResponseHandler = null;
            }
        }

        let data = {
            prime: false,
            name: null,
            steamid: null,
            rank: null,
            wins: null,
            rank_wg: null,
            wins_wg: null,
            rank_dz: null,
            wins_dz: null,
            rank_premier: null,
            wins_premier: null,
            error: null,
            penalty_reason: 0,
            penalty_seconds: 0,
            lvl: 0,
            exp: 0,
            last_game: null,
            maps: {}
        };

        function finish(resolveData) {
            if (Done) return;
            Done = true;
            removeSteamGuardListener();
            if (gcHelloInterval) {
                clearInterval(gcHelloInterval);
                gcHelloInterval = null;
            }
            clearTimeout(outerTimeout);
            if (gcTimeout) clearTimeout(gcTimeout);
            clearCurrentlyChecking(username);
            if (resolveData) {
                // Convert any remaining null rank fields back to 0 for backward
                // compatibility with the UI (which expects numbers, not null)
                normalizeRankNulls(resolveData);
                resolve(resolveData);
            }
            try {
                steamClient.logOff();
            } catch (e) {
                console.error(`[${username}] Error during logoff:`, e);
            }
        }

        // Outer safety-net timeout (45s)
        const outerTimeout = setTimeout(() => {
            if (!Done) {
                console.log(`[${username}] Outer timeout (45s) reached, returning partial data`);
                if (steamClient.steamID) {
                    data.name = data.name || (steamClient.accountInfo ? steamClient.accountInfo.name : username);
                    data.steamid = data.steamid || steamClient.steamID.getSteamID64();
                }
                finish(data);
            }
        }, 45000);

        // GC phase timeout (30s from appLaunched) - initialized when app launches
        let gcTimeout = null;

        steamClient.logOn({
            accountName: username,
            password: pass,
            rememberPassword: true,
        });

        steamClient.on('disconnected', (eresult, msg) => {
            removeSteamGuardListener();
            clearCurrentlyChecking(username);
        });

        steamClient.on('error', (e) => {
            const errorStr = loginErrorString(e.eresult);
            console.log(`[${username}] Login error: ${errorStr} (eresult=${e.eresult})`);
            // A Steam-Guard-invalid result (eresult 65) on the shared-secret
            // TOTP path is the classic symptom of a stale cached time offset:
            // the process caches steamTimeOffset on first use and never
            // refreshes it, so clock drift over a long-running session starts
            // producing codes Steam rejects. Invalidate the cache so the next
            // attempt re-fetches a fresh offset before generating a code.
            if (e.eresult === 65) {
                steamTimeOffset = null;
            }
            removeSteamGuardListener();
            if (gcHelloInterval) {
                clearInterval(gcHelloInterval);
                gcHelloInterval = null;
            }
            clearTimeout(outerTimeout);
            if (gcTimeout) clearTimeout(gcTimeout);
            clearCurrentlyChecking(username);
            if (!Done) {
                Done = true;
                // Reject with the human-readable string as the message (UI
                // compatibility) while carrying the eresult so the retry layer
                // can classify the failure.
                const rejection = new Error(errorStr);
                rejection.eresult = e.eresult;
                reject(rejection);
            }
        });

        steamClient.on('steamGuard', (domain, callback) => {
            // Prefer the shared-secret TOTP path whenever a shared secret exists
            // (works for both mobile-authenticator and, when Steam reports no
            // email domain, app-based Steam Guard).
            if (sharedSecret && sharedSecret.length > 0) {
                if (steamTimeOffset == null) {
                    SteamTotp.getTimeOffset((err, offset) => {
                        if (err) {
                            clearCurrentlyChecking(username);
                            reject(new Error('unable to get steam time offset'));
                            return;
                        }
                        steamTimeOffset = offset;
                        callback(SteamTotp.getAuthCode(sharedSecret, steamTimeOffset));
                    });
                    return;
                }
                callback(SteamTotp.getAuthCode(sharedSecret, steamTimeOffset));
            } else if (!win) {
                clearCurrentlyChecking(username);
                const err = new Error('steam guard missing');
                err.eresult = 63; // classify as steam_guard_required (non-retryable)
                reject(err);
            } else {
                setAccountStatus(username, STATUS.STEAM_GUARD_REQUIRED);
                win.webContents.send('steam:steamguard', username);
                // Scope the response to THIS username so concurrent Steam Guard
                // prompts never deliver one account's code to another's login.
                // The renderer still replies on the shared channel with (code,
                // username); we ignore responses meant for other accounts.
                const responseHandler = (event, code, respondedUsername) => {
                    if (respondedUsername != null && respondedUsername !== username) {
                        return; // not for us - leave the listener in place
                    }
                    removeSteamGuardListener();
                    if (!code) {
                        clearCurrentlyChecking(username);
                        const err = new Error('steam guard missing');
                        err.eresult = 63; // steam_guard_required (non-retryable)
                        reject(err);
                    } else {
                        callback(code);
                    }
                };
                steamGuardResponseHandler = responseHandler;
                ipcMain.on('steam:steamguard:response', responseHandler);
            }
        });

        steamClient.on('webSession', (sessionID, cookies) => {
            setAccountStatus(username, STATUS.LOGGED_IN);
            sleep(1000).then(async () => {
                if (Done) return;
                const cookieHeader = cookies.join('; ') + ';';
                const headers = {
                    'Cookie': cookieHeader,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                };
                const steamid64 = steamClient.steamID.getSteamID64();

                /**
                 * Fetch a URL with retry logic.
                 * @param {string} url
                 * @param {number} maxRetries
                 * @returns {Promise<string|null>} HTML body or null on failure
                 */
                async function fetchWithRetry(url, maxRetries) {
                    if (maxRetries === undefined) maxRetries = 2;
                    for (let attempt = 0; attempt <= maxRetries; attempt++) {
                        try {
                            const res = await axios.get(url, { headers: headers, timeout: 15000 });
                            return res.data;
                        } catch (err) {
                            console.log(`[${username}] HTTP request failed (attempt ${attempt + 1}/${maxRetries + 1}): ${url} - ${err.message}`);
                            if (attempt < maxRetries) {
                                await sleep(2000);
                            }
                        }
                    }
                    return null;
                }

                // 1. Profile page (for name). Fetches the community profile and
                // stores the persona name. Closes over the check scope.
                async function fetchProfileName() {
                    const profileHtml = await fetchWithRetry(`https://steamcommunity.com/profiles/${steamid64}`);
                    if (profileHtml) {
                        const nameMatch = /class="[^"]*persona_name_text_content[^"]*"[^>]*>([^<]+)</.exec(profileHtml);
                        if (nameMatch && nameMatch[1]) {
                            data.name = nameMatch[1].trim();
                            const account = db.get(username);
                            if (account) {
                                account.name = data.name;
                                db.set(username, account);
                                if (win) win.webContents.send('accounts:updated', { login: username, data: account });
                            }
                        }
                    }
                }

                // 2. Account main page (for level and XP).
                async function fetchAccountMain() {
                    const accountMainHtml = await fetchWithRetry(`https://steamcommunity.com/profiles/${steamid64}/gcpd/730?tab=accountmain`);
                    if (!accountMainHtml) return;
                    if (looksLikeLoginPage(accountMainHtml)) {
                        logger.warn('GCPD accountmain returned login page, skipping', { account: username });
                    } else if (looksLikeErrorPage(accountMainHtml)) {
                        logger.warn('GCPD accountmain returned error/private page, treating as data unavailable', { account: username });
                    } else if (looksLikeGcpdPage(accountMainHtml)) {
                        applyAccountMainData(data, accountMainHtml, username, db, win);
                    } else {
                        logger.warn('GCPD accountmain response not recognized as GCPD page', { account: username });
                    }
                }

                // 3. Matchmaking page (for ranks, wins, cooldowns, maps).
                async function fetchMatchmaking() {
                    const matchmakingHtml = await fetchWithRetry(`https://steamcommunity.com/profiles/${steamid64}/gcpd/730?tab=matchmaking`);
                    if (!matchmakingHtml) return;
                    if (looksLikeLoginPage(matchmakingHtml)) {
                        logger.warn('GCPD matchmaking returned login page, skipping', { account: username });
                    } else if (looksLikeErrorPage(matchmakingHtml)) {
                        logger.warn('GCPD matchmaking returned error/private page, treating as data unavailable', { account: username });
                    } else if (looksLikeGcpdPage(matchmakingHtml)) {
                        applyMatchmakingData(data, matchmakingHtml, username);
                    } else {
                        logger.warn('GCPD matchmaking response not recognized as GCPD page', { account: username });
                    }
                }

                try {
                    // Sequential requests with 1s delay between each to avoid rate limiting
                    await fetchProfileName();
                    await sleep(1000);
                    await fetchAccountMain();
                    await sleep(1000);
                    await fetchMatchmaking();

                    // If GC rank data is already done, finish immediately.
                    // Otherwise wait up to 5s for GC rank data before finishing.
                    if (!Done && data.steamid) {
                        if (gcRankDataReady) {
                            finish(data);
                        } else {
                            setTimeout(function() {
                                if (!Done && data.steamid) {
                                    finish(data);
                                }
                            }, 5000);
                        }
                    }
                } catch (error) {
                    console.error(`[${username}] Error fetching web data:`, error.message);
                    // Don't fail the entire check if web scraping fails - GC data may still arrive
                }
            });
        });

        steamClient.on('accountLimitations', function() {
            console.log(`[${username}] Logged in, launching CS2`);
            steamClient.gamesPlayed(730);
        });

        steamClient.on('appLaunched', function(appid) {
            console.log(`[${username}] App ${appid} launched, sending GC hello with version ${GC_HELLO_VERSION}`);

            // Start GC phase timeout (30s)
            gcTimeout = setTimeout(function() {
                if (!Done && !gcWelcomeReceived) {
                    console.log(`[${username}] GC phase timeout (30s), GC not responding`);
                    // Still return whatever data we have
                    if (data.steamid) {
                        finish(data);
                    }
                }
            }, 30000);

            // Send GC hello with version field, retry every GC_HELLO_RETRY_INTERVAL
            function sendGcHello() {
                if (Done || gcWelcomeReceived) return;
                gcHelloAttempts++;
                console.log(`[${username}] Sending GC hello attempt ${gcHelloAttempts}/${GC_HELLO_MAX_ATTEMPTS}`);
                const helloPayload = protoEncode(Protos.csgo.CMsgClientHello, { version: GC_HELLO_VERSION });
                steamClient.sendToGC(appid, GC_MSG.ClientHello, {}, helloPayload);
            }

            // Initial hello after a short delay
            sleep(1000).then(function() {
                if (Done) return;
                sendGcHello();
                gcHelloInterval = setInterval(function() {
                    if (gcHelloAttempts >= GC_HELLO_MAX_ATTEMPTS) {
                        clearInterval(gcHelloInterval);
                        gcHelloInterval = null;
                        if (!Done && !gcWelcomeReceived) {
                            console.log(`[${username}] GC hello max attempts reached (${GC_HELLO_MAX_ATTEMPTS})`);
                            if (data.steamid) {
                                finish(data);
                            }
                        }
                        return;
                    }
                    sendGcHello();
                }, GC_HELLO_RETRY_INTERVAL);
            });
        });

        steamClient.on('receivedFromGC', function(appid, msgType, payload) {
            console.log(`[${username}] receivedFromGC msgType=${msgType}`);

            // Per-msgType GC message handlers. Each is a closure over the
            // enclosing check scope (data, db, steamClient, finish, attempts,
            // gcWelcomeReceived/gcHelloInterval/gcRankDataReady, ...) so the
            // side effects, ordering, and finish/rank-ready signaling are
            // identical to the previous inline switch. The dispatch below
            // selects one by msgType exactly as the switch did.

function processClientWelcomeCacheObject(cache_object, data, username, steamClient, appid, isDone, sleep) {
    if (!cache_object || !Array.isArray(cache_object.object_data) || cache_object.object_data.length === 0) {
        return;
    }
    if (cache_object.type_id === 7 && Protos.csgo.CSOEconGameAccountClient) {
        const CSOEconGameAccountClient = protoDecode(Protos.csgo.CSOEconGameAccountClient, cache_object.object_data[0]);
        if (!((data.lvl > 1) || (data.exp > 0))) {
            data.prime = CSOEconGameAccountClient.elevated_state >= 4;
            console.log(`[${username}] Prime preliminary from elevated_state=${CSOEconGameAccountClient.elevated_state}: ${data.prime}`);
        }
        sleep(1000).then(function() {
            if (isDone()) return;
            steamClient.sendToGC(appid, GC_MSG.MatchmakingClient2GCHello, {}, Buffer.alloc(0));
        });
    }
}

            // GC_MSG.ClientWelcome
            const handleClientWelcome = (appid, payload) => {
                gcWelcomeReceived = true;
                if (gcHelloInterval) {
                    clearInterval(gcHelloInterval);
                    gcHelloInterval = null;
                }

                if (!Protos.csgo.CMsgClientWelcome) {
                    console.error(`[${username}] CMsgClientWelcome proto not found`);
                    return;
                }
                const CMsgClientWelcome = protoDecode(Protos.csgo.CMsgClientWelcome, payload);
                const outofdateCaches = Array.isArray(CMsgClientWelcome.outofdate_subscribed_caches)
                    ? CMsgClientWelcome.outofdate_subscribed_caches
                    : [];
                for (let i = 0; i < outofdateCaches.length; i++) {
                    const outofdate_cache = outofdateCaches[i];
                    const cacheObjects = Array.isArray(outofdate_cache.objects) ? outofdate_cache.objects : [];
                    for (let j = 0; j < cacheObjects.length; j++) {
                        processClientWelcomeCacheObject(cacheObjects[j], data, username, steamClient, appid, () => Done, sleep);
                    }
                }
            };

            // Request all rank types plus the comprehensive player profile.
            // Extracted from the MatchmakingGC2ClientHello handler unchanged.
            const requestAllRankTypes = (appid) => {
                let rankUpdateMsg = protoEncode(Protos.csgo.CMsgGCCStrike15_v2_ClientGCRankUpdate, {
                    rankings: [
                        { rank_type_id: 6 },
                        { rank_type_id: 7 },
                        { rank_type_id: 10 },
                        { rank_type_id: 11 }
                    ]
                });
                steamClient.sendToGC(appid, GC_MSG.ClientGCRankUpdate, {}, rankUpdateMsg);

                // Also request player profile for comprehensive rank data
                if (Protos.csgo.CMsgGCCStrike15_v2_ClientRequestPlayersProfile) {
                    let profileReqMsg = protoEncode(Protos.csgo.CMsgGCCStrike15_v2_ClientRequestPlayersProfile, {
                        account_id: steamClient.steamID.accountid,
                        request_level: 32
                    });
                    steamClient.sendToGC(appid, GC_MSG.RequestPlayersProfile, {}, profileReqMsg);
                }
            };

            // Apply a resolved MatchmakingGC2ClientHello message to `data`.
            // Every field/ternary is byte-for-behavior identical to the
            // original else-branch; the vac_banned/-1 and communityBanned
            // branches and the prime-status db write are preserved exactly.
            const applyHelloResult = (msg) => {
                // Guard every field: protoDecode may return {} and
                // msg.ranking may be absent when attempts hit the cap.
                const limitations = steamClient.limitations || {};
                const ranking = msg.ranking || {};
                const haveRanking = attempts < 5 && msg.ranking != null;
                data.penalty_reason = limitations.communityBanned ? 'Community ban' : msg.penalty_reason > 0 ? penalty_reason_string(msg.penalty_reason) : msg.vac_banned ? 'VAC' : 0;
                data.penalty_seconds = msg.vac_banned || limitations.communityBanned || penalty_reason_permanent(msg.penalty_reason) ? -1 : msg.penalty_seconds > 0 ? (Math.floor(Date.now() / 1000) + msg.penalty_seconds) : 0;
                data.wins = msg.vac_banned ? -1 : haveRanking ? (ranking.wins || 0) : 0;
                data.rank = msg.vac_banned ? -1 : haveRanking ? (ranking.rank_id || 0) : 0;
                data.name = (steamClient.accountInfo && steamClient.accountInfo.name) || data.name || username;
                data.lvl = msg.player_level || data.lvl;
                data.steamid = steamClient.steamID.getSteamID64();
                data.error = null;

                // Final prime determination based on level/xp heuristic
                data.prime = (data.lvl > 1) || (data.exp > 0);

                // Save prime status
                let account = db.get(username);
                if (account) {
                    account.prime = data.prime;
                    db.set(username, account);
                }
            };

            // GC_MSG.MatchmakingGC2ClientHello
            const handleMatchmakingHello = (appid, payload) => {
                        requestAllRankTypes(appid);

                        if (!Protos.csgo.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello) {
                            console.error('Proto type CMsgGCCStrike15_v2_MatchmakingGC2ClientHello not loaded');
                            return;
                        }
                        let msg = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello, payload);

                        ++attempts;
                        if (!msg.ranking && attempts < 5 && !msg.vac_banned) {
                            sleep(2000).then(function() {
                                if (Done) return;
                                steamClient.sendToGC(appid, GC_MSG.MatchmakingClient2GCHello, {}, Buffer.alloc(0));
                            });
                        } else {
                            applyHelloResult(msg);
                        }
            };

            // Apply a single account profile's level/XP to `data` and recompute
            // the prime heuristic. Extracted from handlePlayersProfile unchanged.
            const applyProfileLevelAndXp = (profile) => {
                // Extract player level and XP from profile
                if (profile.player_level && profile.player_level > 0) {
                    data.lvl = profile.player_level;
                }
                if (profile.player_cur_xp && profile.player_cur_xp > 0) {
                    // Convert raw absolute XP to XP-within-level. This path
                    // always subtracts the base (no guard), matching the
                    // original PlayersProfile behavior.
                    data.exp = xpModuloLevel(profile.player_cur_xp);
                }
                // Final prime determination based on level/xp heuristic
                data.prime = (data.lvl > 1) || (data.exp > 0);
            };

            // Apply a single account profile's rankings to `data`.
            //
            // A ranking ENTRY being present for a rank_type_id is the
            // authoritative signal that CS2 reported that mode. protobufjs
            // decodes unset numeric fields to 0 (defaults:true), so an EXPIRED
            // rank legitimately arrives as rank_id === 0. applyGcRanking therefore
            // assigns unconditionally when the entry exists (mirroring the
            // ClientGCRankUpdate handler) rather than using truthiness guards,
            // which would silently drop the expired state (rank 0) and skip
            // writing wins === 0. It never overwrites a VAC/ban sentinel (-1)
            // that an earlier handler established.
            const applyProfileRankings = (profile) => {
                if (Array.isArray(profile.rankings) && profile.rankings.length > 0) {
                    for (let r = 0; r < profile.rankings.length; r++) {
                        applyGcRanking(data, profile.rankings[r]);
                    }
                    logger.debug('PlayersProfile ranks resolved', {
                        account: username,
                        rank: data.rank, wins: data.wins,
                        rank_wg: data.rank_wg, wins_wg: data.wins_wg,
                        rank_dz: data.rank_dz, wins_dz: data.wins_dz,
                        rank_premier: data.rank_premier, wins_premier: data.wins_premier
                    });
                }
            };

            // GC_MSG.PlayersProfile (msg 9128)
            const handlePlayersProfile = (appid, payload) => {
                // Decode player profile response (msg 9128)
                if (!Protos.csgo.CMsgGCCStrike15_v2_PlayersProfile) {
                    console.log(`[${username}] CMsgGCCStrike15_v2_PlayersProfile proto not available`);
                    return;
                }
                        let profileMsg = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_PlayersProfile, payload);
                        if (profileMsg.account_profiles && profileMsg.account_profiles.length > 0) {
                            for (let p = 0; p < profileMsg.account_profiles.length; p++) {
                                const profile = profileMsg.account_profiles[p];
                                applyProfileLevelAndXp(profile);
                                applyProfileRankings(profile);
                            }
                            console.log(`[${username}] Profile data received: lvl=${data.lvl}, exp=${data.exp}`);
                        }
            };

            // ClientGCRankUpdate (msg 9194) rank entries are applied by the
            // data-driven applyGcRankUpdateEntry helper in helpers/rankMerge.js
            // (GC_RANK_UPDATE_TYPES table + VAC cascade + premier expired guard).
            // The log callback reproduces the original per-entry console.log
            // placement: label after assignment, before the VAC cascade.
            const logRankUpdate = (label, rankValue, winsValue) => {
                console.log(`[${username}] ${label}: ${rankValue}, wins: ${winsValue}`);
            };

            // GC_MSG.ClientGCRankUpdate (msg 9194)
            const handleClientGCRankUpdate = (appid, payload) => {
                        let msg = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_ClientGCRankUpdate, payload);
                        if (!msg.rankings || !Array.isArray(msg.rankings)) {
                            gcRankDataReady = true;
                            return;
                        }
                        for (const ranking of msg.rankings) {
                            if (!ranking) continue;
                            applyGcRankUpdateEntry(data, ranking, logRankUpdate);
                        }

                        // If we have steamid and at least one rank has been set, we can finish
                        gcRankDataReady = true;
                        if (data.steamid != null &&
                            (data.rank != null || data.rank_wg != null || data.rank_dz != null || data.rank_premier != null)) {
                            data.error = null;
                            finish(data);
                        }
            };

            // Dispatch table: msgType -> handler. Mirrors the original switch
            // exactly; unlisted msgTypes are ignored (the switch had no default).
            const GC_HANDLERS = {
                [GC_MSG.ClientWelcome]: handleClientWelcome,
                [GC_MSG.MatchmakingGC2ClientHello]: handleMatchmakingHello,
                [GC_MSG.PlayersProfile]: handlePlayersProfile,
                [GC_MSG.ClientGCRankUpdate]: handleClientGCRankUpdate
            };

            try {
                const handler = GC_HANDLERS[msgType];
                if (handler) {
                    handler(appid, payload);
                }
            } catch (error) {
                console.error(`[${username}] Error processing GC message ${msgType}:`, error);
            }
        });
    });
}

process.on('uncaughtException', err => {
  logger.error('uncaughtException', { op: 'process', error: err });
})

process.on('unhandledRejection', reason => {
  // Route through the redacting logger so any secrets carried on the rejection
  // (passwords, shared secrets, cookies) are stripped before being written.
  logger.error('unhandledRejection', { op: 'process', error: reason });
})

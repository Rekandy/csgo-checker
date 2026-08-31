const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
const { parseMatchmaking, parseAccountMain, looksLikeGcpdPage, looksLikeLoginPage } = require('./helpers/gcpd_parser.js');
const logger = require('./helpers/logger.js');
const { parseAccountLines } = require('./helpers/importParser.js');
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

function beforeWindowInputHandler(window, event, input) {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        window.webContents.openDevTools();
        event.preventDefault();
    }
    if (input.control && input.key.toLowerCase() === 'r') {
        window.reload();
    }
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
                let pass = await new Promise((resolve, reject) => {
                    passwordPromptResponse = null;
                    let promptWindow = new BrowserWindow({
                        ...browserWindowOptions,
                        width: 500,
                        height: 280,
                        resizable: false,
                        show: false
                    });
                    promptWindow.removeMenu();
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
                try {
                    if (pass == null || pass.length == 0) {
                        throw 'Password can not be empty';
                    }
                    db = await new Promise((res, rej) => {
                        try {
                            let db = new EncryptedStorage(ACCOUNTS_ENCRYPTED_PATH, pass);
                            db.on('error', rej);//this is for async errors
                            db.on('loaded', () => res(db));
                        } catch (error) {
                            rej(error);
                        }
                    })
                    //we decrypted successfully, exit loop
                    break;
                } catch (error) {
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

function createWindow () {

    win = new BrowserWindow({
        ...browserWindowOptions,
        
        width: 1100,
        height: 650,
        minWidth: 1100,
        minHeight: 625
    });
    win.removeMenu();
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

async function process_check_account(username) {
    const account = db.get(username);
    if(!account) {
        return { error: 'unable to find account' };
    }

    try {
        const res = await check_account(username, account.password, account.sharedSecret);
        logger.debug('Account check completed', { account: username, op: 'check' });
        for (const key in res) {
            if (Object.hasOwnProperty.call(res, key)) {
                account[key] = res[key];
            }
        }
        db.set(username, account);
        return res;
    } catch (error) {
        logger.error('Account check failed', { account: username, op: 'check', error });
        account.error = error;
        db.set(username, account);
        return { error: error };
    }
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
    for (const acc of accounts) {
        process_check_account(acc.username);
        await new Promise(p => setTimeout(p, 200));
    }
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

        let Done = false;
        let attempts = 0;
        let gcHelloInterval = null;
        let gcHelloAttempts = 0;
        let gcWelcomeReceived = false;
        let gcRankDataReady = false;
        let steamClient = new User();

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
            if (gcHelloInterval) {
                clearInterval(gcHelloInterval);
                gcHelloInterval = null;
            }
            clearTimeout(outerTimeout);
            if (gcTimeout) clearTimeout(gcTimeout);
            currently_checking = currently_checking.filter(x => x !== username);
            if (resolveData) {
                // Convert any remaining null rank fields back to 0 for backward
                // compatibility with the UI (which expects numbers, not null)
                if (resolveData.rank == null) resolveData.rank = 0;
                if (resolveData.wins == null) resolveData.wins = 0;
                if (resolveData.rank_wg == null) resolveData.rank_wg = 0;
                if (resolveData.wins_wg == null) resolveData.wins_wg = 0;
                if (resolveData.rank_dz == null) resolveData.rank_dz = 0;
                if (resolveData.wins_dz == null) resolveData.wins_dz = 0;
                if (resolveData.rank_premier == null) resolveData.rank_premier = 0;
                if (resolveData.wins_premier == null) resolveData.wins_premier = 0;
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
            currently_checking = currently_checking.filter(x => x !== username);
        });

        steamClient.on('error', (e) => {
            let errorStr = '';
            switch (e.eresult) {
                case 2:  errorStr = `General Failure`;          break;
                case 5:  errorStr = `Invalid Password`;         break;
                case 6:
                case 34: errorStr = `Logged In Elsewhere`;      break;
                case 18: errorStr = `Expired`;                  break;
                case 65: errorStr = `steam guard is invalid`;   break;
                case 84: errorStr = `Rate Limit Exceeded`;      break;
                default: errorStr = `Unknown: ${e.eresult}`;    break;
            }
            console.log(`[${username}] Login error: ${errorStr} (eresult=${e.eresult})`);
            if (gcHelloInterval) {
                clearInterval(gcHelloInterval);
                gcHelloInterval = null;
            }
            clearTimeout(outerTimeout);
            if (gcTimeout) clearTimeout(gcTimeout);
            currently_checking = currently_checking.filter(x => x !== username);
            if (!Done) {
                Done = true;
                reject(errorStr);
            }
        });

        steamClient.on('steamGuard', (domain, callback) => {
            if (domain == null && sharedSecret && sharedSecret.length > 0) {
                if (steamTimeOffset == null) {
                    SteamTotp.getTimeOffset((err, offset) => {
                        if (err) {
                            currently_checking = currently_checking.filter(x => x !== username);
                            reject(`unable to get steam time offset`);
                            return;
                        }
                        steamTimeOffset = offset;
                        callback(SteamTotp.getAuthCode(sharedSecret, steamTimeOffset));
                    });
                    return;
                }
                callback(SteamTotp.getAuthCode(sharedSecret, steamTimeOffset));
            } else if (!win) {
                currently_checking = currently_checking.filter(x => x !== username);
                reject(`steam guard missing`);
            } else {
                win.webContents.send('steam:steamguard', username);
                ipcMain.once('steam:steamguard:response', async (event, code) => {
                    if (!code) {
                        currently_checking = currently_checking.filter(x => x !== username);
                        reject(`steam guard missing`);
                    } else {
                        callback(code);
                    }
                });
            }
        });

        steamClient.on('webSession', (sessionID, cookies) => {
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

                try {
                    // Sequential requests with 1s delay between each to avoid rate limiting

                    // 1. Profile page (for name)
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

                    await sleep(1000);

                    // 2. Account main page (for level and XP)
                    const accountMainHtml = await fetchWithRetry(`https://steamcommunity.com/profiles/${steamid64}/gcpd/730?tab=accountmain`);
                    if (accountMainHtml) {
                        if (looksLikeLoginPage(accountMainHtml)) {
                            console.log(`[${username}] GCPD accountmain returned login page, skipping`);
                        } else if (looksLikeGcpdPage(accountMainHtml)) {
                            const accountData = parseAccountMain(accountMainHtml);
                            if (accountData.ok) {
                                if (accountData.cs2_player_level >= 0) {
                                    data.lvl = accountData.cs2_player_level;
                                }
                                if (accountData.cs2_player_xp >= 0) {
                                    // Convert raw absolute XP to XP-within-level if it looks like a raw value
                                    const XP_BASE = 327680000;
                                    const XP_PER_LEVEL = 5000;
                                    if (accountData.cs2_player_xp > XP_BASE) {
                                        let into = accountData.cs2_player_xp - XP_BASE;
                                        if (into < 0) into = 0;
                                        data.exp = into % XP_PER_LEVEL;
                                    } else {
                                        data.exp = accountData.cs2_player_xp;
                                    }
                                }

                                // Final prime determination based on level/xp heuristic
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
                        } else {
                            console.log(`[${username}] GCPD accountmain response not recognized as GCPD page`);
                        }
                    }

                    await sleep(1000);

                    // 3. Matchmaking page (for ranks, wins, cooldowns, maps)
                    const matchmakingHtml = await fetchWithRetry(`https://steamcommunity.com/profiles/${steamid64}/gcpd/730?tab=matchmaking`);
                    if (matchmakingHtml) {
                        if (looksLikeLoginPage(matchmakingHtml)) {
                            console.log(`[${username}] GCPD matchmaking returned login page, skipping`);
                        } else if (looksLikeGcpdPage(matchmakingHtml)) {
                            const mmData = parseMatchmaking(matchmakingHtml);
                            if (mmData.ok) {
                                if (mmData.premier_rating > 0) {
                                    data.rank_premier = mmData.premier_rating;
                                }
                                if (mmData.premier_wins > 0) {
                                    data.wins_premier = mmData.premier_wins;
                                }
                                if (mmData.wingman_rank > 0) {
                                    data.rank_wg = mmData.wingman_rank;
                                }
                                if (mmData.wingman_wins > 0) {
                                    data.wins_wg = mmData.wingman_wins;
                                }
                            }

                            // Extract map data using regex (parser does not cover per-map data)
                            const mapsData = {};
                            const mapRows = matchmakingHtml.match(/<tr>[\s\S]*?<td>Ranked Competitive<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([^<]*)<\/td>[\s\S]*?<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<\/tr>/g);
                            if (mapRows) {
                                mapRows.forEach(function(row) {
                                    const mapMatch = /<td>Ranked Competitive<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([^<]*)<\/td>[\s\S]*?<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>[\s\S]*?<td>(\d+)<\/td>/.exec(row);
                                    if (mapMatch) {
                                        mapsData[mapMatch[1].trim()] = {
                                            wins: parseInt(mapMatch[2]),
                                            ties: parseInt(mapMatch[3]),
                                            losses: parseInt(mapMatch[4]),
                                            skill_group: mapMatch[5].trim() || null,
                                            last_match: mapMatch[6],
                                            region: parseInt(mapMatch[7])
                                        };
                                    }
                                });
                            }
                            data.maps = mapsData;

                            // Try extracting last_game date from matchmaking tables
                            const lastGameMatch = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT)/.exec(matchmakingHtml);
                            if (lastGameMatch) {
                                data.last_game = new Date(lastGameMatch[1]);
                            }
                        } else {
                            console.log(`[${username}] GCPD matchmaking response not recognized as GCPD page`);
                        }
                    }

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
            try {
                switch (msgType) {
                    case GC_MSG.ClientWelcome: {
                        gcWelcomeReceived = true;
                        if (gcHelloInterval) {
                            clearInterval(gcHelloInterval);
                            gcHelloInterval = null;
                        }

                        if (!Protos.csgo.CMsgClientWelcome) {
                            console.error(`[${username}] CMsgClientWelcome proto not found`);
                            return;
                        }
                        let CMsgClientWelcome = protoDecode(Protos.csgo.CMsgClientWelcome, payload);
                        for (let i = 0; i < CMsgClientWelcome.outofdate_subscribed_caches.length; i++) {
                            let outofdate_cache = CMsgClientWelcome.outofdate_subscribed_caches[i];
                            for (let j = 0; j < outofdate_cache.objects.length; j++) {
                                let cache_object = outofdate_cache.objects[j];
                                if (cache_object.object_data.length == 0) {
                                    continue;
                                }
                                switch (cache_object.type_id) {
                                    case 7: {
                                        let CSOEconGameAccountClient = protoDecode(Protos.csgo.CSOEconGameAccountClient, cache_object.object_data[0]);
                                        if (CSOEconGameAccountClient.elevated_state >= 4) {
                                            data.prime = true;
                                            console.log(`[${username}] Has Prime status (elevated_state=${CSOEconGameAccountClient.elevated_state}, preliminary)`);
                                        } else {
                                            data.prime = false;
                                            console.log(`[${username}] No Prime status (elevated_state=${CSOEconGameAccountClient.elevated_state}, preliminary)`);
                                        }

                                        sleep(1000).then(function() {
                                            if (Done) return;
                                            steamClient.sendToGC(appid, GC_MSG.MatchmakingClient2GCHello, {}, Buffer.alloc(0));
                                        });
                                        break;
                                    }
                                }
                            }
                        }
                        break;
                    }
                    case GC_MSG.MatchmakingGC2ClientHello: {
                        // Request all rank types
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

                        if (!Protos.csgo.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello) {
                            console.error('Proto type CMsgGCCStrike15_v2_MatchmakingGC2ClientHello not loaded');
                            break;
                        }
                        let msg = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello, payload);

                        ++attempts;
                        if (!msg.ranking && attempts < 5 && !msg.vac_banned) {
                            sleep(2000).then(function() {
                                if (Done) return;
                                steamClient.sendToGC(appid, GC_MSG.MatchmakingClient2GCHello, {}, Buffer.alloc(0));
                            });
                        } else {
                            data.penalty_reason = steamClient.limitations.communityBanned ? 'Community ban' : msg.penalty_reason > 0 ? penalty_reason_string(msg.penalty_reason) : msg.vac_banned ? 'VAC' : 0;
                            data.penalty_seconds = msg.vac_banned || steamClient.limitations.communityBanned || penalty_reason_permanent(msg.penalty_reason) ? -1 : msg.penalty_seconds > 0 ? (Math.floor(Date.now() / 1000) + msg.penalty_seconds) : 0;
                            data.wins = msg.vac_banned ? -1 : attempts < 5 ? msg.ranking.wins : 0;
                            data.rank = msg.vac_banned ? -1 : attempts < 5 ? msg.ranking.rank_id : 0;
                            data.name = steamClient.accountInfo.name;
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
                        }
                        break;
                    }
                    case GC_MSG.PlayersProfile: {
                        // Decode player profile response (msg 9128)
                        if (!Protos.csgo.CMsgGCCStrike15_v2_PlayersProfile) {
                            console.log(`[${username}] CMsgGCCStrike15_v2_PlayersProfile proto not available`);
                            break;
                        }
                        let profileMsg = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_PlayersProfile, payload);
                        if (profileMsg.account_profiles && profileMsg.account_profiles.length > 0) {
                            for (let p = 0; p < profileMsg.account_profiles.length; p++) {
                                const profile = profileMsg.account_profiles[p];
                                // Extract player level and XP from profile
                                if (profile.player_level && profile.player_level > 0) {
                                    data.lvl = profile.player_level;
                                }
                                if (profile.player_cur_xp && profile.player_cur_xp > 0) {
                                    // Convert raw absolute XP to XP-within-level
                                    const XP_BASE = 327680000;
                                    const XP_PER_LEVEL = 5000;
                                    let into = profile.player_cur_xp - XP_BASE;
                                    if (into < 0) into = 0;
                                    data.exp = into % XP_PER_LEVEL;
                                }
                                // Final prime determination based on level/xp heuristic
                                data.prime = (data.lvl > 1) || (data.exp > 0);
                                // Extract rankings from profile
                                if (profile.rankings && profile.rankings.length > 0) {
                                    for (let r = 0; r < profile.rankings.length; r++) {
                                        const ranking = profile.rankings[r];
                                        switch (ranking.rank_type_id) {
                                            case 6: // competitive
                                                if (ranking.rank_id) data.rank = ranking.rank_id;
                                                if (ranking.wins) data.wins = ranking.wins;
                                                break;
                                            case 7: // wingman
                                                if (ranking.rank_id) data.rank_wg = ranking.rank_id;
                                                if (ranking.wins) data.wins_wg = ranking.wins;
                                                break;
                                            case 10: // dangerzone
                                                if (ranking.rank_id) data.rank_dz = ranking.rank_id;
                                                if (ranking.wins) data.wins_dz = ranking.wins;
                                                break;
                                            case 11: // premier
                                                if (ranking.rank_id) data.rank_premier = ranking.rank_id;
                                                if (ranking.wins) data.wins_premier = ranking.wins;
                                                break;
                                        }
                                    }
                                }
                            }
                            console.log(`[${username}] Profile data received: lvl=${data.lvl}, exp=${data.exp}`);
                        }
                        break;
                    }
                    case GC_MSG.ClientGCRankUpdate: {
                        let msg = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_ClientGCRankUpdate, payload);
                        if (!msg.rankings || !Array.isArray(msg.rankings)) {
                            gcRankDataReady = true;
                            break;
                        }
                        for (const ranking of msg.rankings) {
                            if (ranking.rank_type_id == 6) { // competitive
                                data.wins = ranking.wins;
                                data.rank = ranking.rank_id;
                                console.log(`[${username}] Competitive rank: ${data.rank}, wins: ${data.wins}`);
                            }
                            if (ranking.rank_type_id == 7) { // wingman
                                data.wins_wg = ranking.wins;
                                data.rank_wg = ranking.rank_id;
                                console.log(`[${username}] Wingman rank: ${data.rank_wg}, wins: ${data.wins_wg}`);
                                if (data.wins === -1) { // vac banned
                                    data.wins_wg = -1;
                                    data.rank_wg = -1;
                                }
                            }
                            if (ranking.rank_type_id == 10) { // dangerzone
                                data.wins_dz = ranking.wins;
                                data.rank_dz = ranking.rank_id;
                                console.log(`[${username}] Danger Zone rank: ${data.rank_dz}, wins: ${data.wins_dz}`);
                                if (data.wins === -1) { // vac banned
                                    data.wins_dz = -1;
                                    data.rank_dz = -1;
                                }
                            }
                            if (ranking.rank_type_id == 11) { // premier
                                data.wins_premier = ranking.wins;
                                data.rank_premier = ranking.rank_id;
                                console.log(`[${username}] Premier rank: ${data.rank_premier}, wins: ${data.wins_premier}`);
                                if (data.wins === -1) { // vac banned
                                    data.wins_premier = -1;
                                    data.rank_premier = -1;
                                }
                            }
                        }

                        // If we have steamid and at least one rank has been set, we can finish
                        gcRankDataReady = true;
                        if (data.steamid != null &&
                            (data.rank != null || data.rank_wg != null || data.rank_dz != null || data.rank_premier != null)) {
                            data.error = null;
                            finish(data);
                        }
                        break;
                    }
                }
            } catch (error) {
                console.error(`[${username}] Error processing GC message ${msgType}:`, error);
            }
        });
    });
}

process.on('uncaughtException', err => {
  console.error('uncaughtException', err);
})

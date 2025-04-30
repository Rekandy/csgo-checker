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
// Исправление загрузки proto-файлов
let Protos;
try {
    console.log('Loading proto files for csgo...');
    const protoFiles = [
        path.join(__dirname, '/protos/cstrike15_gcmessages.proto'),
        path.join(__dirname, '/protos/gcsdk_gcmessages.proto'),
        path.join(__dirname, '/protos/base_gcmessages.proto')
    ];
    
    // Проверяем существование файлов
    protoFiles.forEach((file, index) => {
        if (fs.existsSync(file)) {
            console.log(`Found proto file ${index + 1}: ${file}`);
        } else {
            console.error(`Proto file not found: ${file}`);
        }
    });
    
    Protos = require('./helpers/protos.js')([{
        name: 'csgo',
        protos: protoFiles
    }]);
    console.log('Proto files loaded successfully');
} catch (error) {
    console.error('Error loading proto files:', error);
    Protos = { csgo: {} }; // Пустой объект для предотвращения ошибок
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
            console.log(err);
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
        console.log(error);
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
            console.log(error);
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
        console.log(res);
        for (const key in res) {
            if (Object.hasOwnProperty.call(res, key)) {
                account[key] = res[key];
            }
        }
        db.set(username, account);
        return res;
    } catch (error) {
        console.log(error);
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
    let accs = fs.readFileSync(file).toString().split('\n').map(x => x.trim().split(':')).filter(x => x && x.length == 2);
    accs.forEach(acc => {
        db.set(acc[0], {
            password: acc[1],
        });
    });
    for (const acc of accs) {
        process_check_account(acc[0]);
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
    let accs = Object.entries(db.JSON()).map(x => x[0] + ':' + x[1].password).join(EOL);
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
        // Добавляем таймаут для предотвращения бесконечной загрузки
        const timeout = setTimeout(() => {
            if (steamClient && !Done) {
                console.log(`Таймаут для аккаунта ${username}, завершаем проверку`);
                Done = true;
                
                // Если у нас есть хоть какие-то данные, возвращаем их
                if (steamClient.steamID) {
                    let data = {
                        name: steamClient.accountInfo ? steamClient.accountInfo.name : username,
                        steamid: steamClient.steamID.getSteamID64(),
                        rank: 0,
                        wins: 0,
                        rank_wg: 0,
                        wins_wg: 0,
                        rank_dz: 0,
                        wins_dz: 0,
                        rank_premier: 0,
                        wins_premier: 0,
                        prime: false,
                        error: null
                    };
                    
                    currently_checking = currently_checking.filter(x => x !== username);
                    resolve(data);
                    try {
                        steamClient.logOff();
                    } catch (e) {
                        console.error(`Ошибка при отключении аккаунта ${username}:`, e);
                    }
                }
            }
        }, 30000); // 30 секунд должно быть достаточно
        sleep = (ms) => {
            return new Promise(resolve=>{
                setTimeout(resolve, ms);
            });
        }
        currently_checking.push(username);

        let attempts = 0;
        let Done = false;
        let steamClient = new User();

        steamClient.logOn({
            accountName: username,
            password: pass,
            rememberPassword: true,
        });

        steamClient.on('disconnected', (eresult, msg) => {
            currently_checking = currently_checking.filter(x => x !== username);
        });

        steamClient.on('error', (e) => {
            let errorStr = ``;
            switch(e.eresult) {
                case 5:  errorStr = `Invalid Password`;         break;
                case 6:
                case 34: errorStr = `Logged In Elsewhere`;      break;
                case 84: errorStr = `Rate Limit Exceeded`;     break;
                case 65: errorStr = `steam guard is invalid`;  break;
                default: errorStr = `Unknown: ${e.eresult}`;    break;
            }
            currently_checking = currently_checking.filter(x => x !== username);
            reject(errorStr);
        });

        steamClient.on('steamGuard', (domain, callback) => {
            if (domain == null && sharedSecret && sharedSecret.length > 0) { //domain will be null for mobile authenticator
                if (steamTimeOffset == null) {
                    SteamTotp.getTimeOffset((err, offset) => {
                        if (err) {
                            currently_checking = currently_checking.filter(x => x !== username);
                            reject(`unable to get steam time offset`);
                            return
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
                try {
                    // Объединяем все запросы в один Promise.all для параллельного выполнения
                    const [profileRes, accountMainRes, matchmakingRes] = await Promise.all([
                        axios.get(`https://steamcommunity.com/profiles/${steamClient.steamID.getSteamID64()}`, {
                            headers: { 'Cookie': cookies.join('; ') + ';' }
                        }),
                        axios.get(`https://steamcommunity.com/profiles/${steamClient.steamID.getSteamID64()}/gcpd/730?tab=accountmain`, {
                            headers: { 'Cookie': cookies.join('; ') + ';' }
                        }),
                        axios.get(`https://steamcommunity.com/profiles/${steamClient.steamID.getSteamID64()}/gcpd/730?tab=matchmaking`, {
                            headers: { 'Cookie': cookies.join('; ') + ';' }
                        })
                    ]);

                    // Обработка имени аккаунта
                    const nameMatch = /class="[^"]*persona_name_text_content[^"]*"[^>]*>([^<]+)</.exec(profileRes.data);
                    if (nameMatch?.[1]) {
                        data.name = nameMatch[1].trim();
                        const account = db.get(username);
                        if (account) {
                            account.name = data.name;
                            db.set(username, account);
                            win?.webContents.send('accounts:updated', { login: username, data: account });
                        }
                    }

                    // Обработка уровня профиля и опыта
                    const profileRankMatch = /CS:GO Profile Rank:\s*(\d+)/.exec(accountMainRes.data);
                    const expMatch = /Experience points earned towards next rank:\s*(\d+)/.exec(accountMainRes.data);
                    
                    if (profileRankMatch?.[1]) {
                        data.lvl = parseInt(profileRankMatch[1]);
                        if (expMatch?.[1]) {
                            data.exp = parseInt(expMatch[1]);
                        }
                        
                        const account = db.get(username);
                        if (account) {
                            account.lvl = data.lvl;
                            if (data.exp !== undefined) account.exp = data.exp;
                            db.set(username, account);
                            win?.webContents.send('accounts:updated', { login: username, data: account });
                        }
                    }

                    // Регулярные выражения для извлечения данных о рангах
                    const rankRegex = {
                        mm: /<td>Competitive<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>([^<]*)<\/td>\s*<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>\s*<td>([^<]*)<\/td>/,
                        wg: /<td>Wingman<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>([^<]*)<\/td>\s*<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>\s*<td>([^<]*)<\/td>/,
                        dz: /<td>Danger Zone<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>([^<]*)<\/td>\s*<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>\s*<td>([^<]*)<\/td>/,
                        premier: /<td>Premier(?:\s*Matchmaking)?<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>([^<]*)<\/td>\s*<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>\s*<td>([^<]*)<\/td>/
                    };

                    // Извлекаем все данные о рангах одним проходом
                    const matches = {
                        mm: rankRegex.mm.exec(matchmakingRes.data),
                        wg: rankRegex.wg.exec(matchmakingRes.data),
                        dz: rankRegex.dz.exec(matchmakingRes.data),
                        premier: rankRegex.premier.exec(matchmakingRes.data)
                    };

                    // Обработка данных о рангах
                    if (matches.mm) {
                        data.last_game = new Date(matches.mm[5]);
                        data.wins = parseInt(matches.mm[1]);
                        data.rank = parseInt(matches.mm[4]) || 0;
                    }
                    if (matches.wg) {
                        data.last_game_wg = new Date(matches.wg[5]);
                        data.wins_wg = parseInt(matches.wg[1]);
                        data.rank_wg = parseInt(matches.wg[4]) || 0;
                    }
                    if (matches.dz) {
                        data.last_game_dz = new Date(matches.dz[5]);
                        data.wins_dz = parseInt(matches.dz[1]);
                        data.rank_dz = parseInt(matches.dz[4]) || 0;
                    }
                    if (matches.premier) {
                        data.last_game_premier = new Date(matches.premier[5]);
                        data.wins_premier = parseInt(matches.premier[1]);
                        data.rank_premier = parseInt(matches.premier[4]) || 0;
                    }

                    // Обработка данных о картах
                    const mapsData = {};
                    const mapRows = matchmakingRes.data.match(/<tr>[\s\S]*?<td>Ranked Competitive<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([^<]*)<\/td>[\s\S]*?<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<\/tr>/g);
                    
                    if (mapRows) {
                        mapRows.forEach(row => {
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

                    if (!Done) {
                        Done = true;
                        clearTimeout(timeout);
                        currently_checking = currently_checking.filter(x => x !== username);
                        resolve(data);
                        steamClient.logOff();
                    }
                } catch (error) {
                    console.error(`Ошибка при получении данных для ${username}:`, error);
                    if (!Done) {
                        Done = true;
                        currently_checking = currently_checking.filter(x => x !== username);
                        reject(error.message);
                        steamClient.logOff();
                    }
                }
            });
        });

        steamClient.on('accountLimitations', () => {
            console.log(`logged into account ${username}`);
            steamClient.gamesPlayed(730);
        });

        steamClient.on('appLaunched', (appid) => {
            console.log(`app ${appid} launched on account ${username}`);
            sleep(5000).then(() => {
                steamClient.sendToGC(appid, 4006, {}, Buffer.alloc(0));
            });
        });

        let data = {
            prime: false,
            name: null,
            steamid: null,
            rank: 0,
            wins: 0,
            rank_wg: 0,
            wins_wg: 0,
            rank_dz: 0,
            wins_dz: 0,
            rank_premier: 0,
            wins_premier: 0,
            error: null
        };

        steamClient.on('receivedFromGC', (appid, msgType, payload) => {
            console.log(`receivedFromGC ${msgType} on account ${username}`);
            try {
                switch(msgType) {
                    case 4004: {
                        if (!Protos.csgo.CMsgClientWelcome) {
                            console.error(`Ошибка: Protos.csgo.CMsgClientWelcome не найден`);
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
                                // Проверяем прайм-статус
                                console.log(`Проверка прайм-статуса для ${username}, elevated_state:`, CSOEconGameAccountClient.elevated_state);
                                if (CSOEconGameAccountClient.elevated_state == 5) { // bought prime
                                    data.prime = true;
                                    console.log(`Аккаунт ${username} имеет прайм-статус`);
                                } else {
                                    data.prime = false;
                                    console.log(`Аккаунт ${username} не имеет прайм-статус`);
                                }
                                if (data.rank_wg === undefined) data.rank_wg = 0;
                                if (data.wins_wg === undefined) data.wins_wg = 0;
                                if (data.rank_dz === undefined) data.rank_dz = 0;
                                if (data.wins_dz === undefined) data.wins_dz = 0;
                                if (data.rank_premier === undefined) data.rank_premier = 0;
                                if (data.wins_premier === undefined) data.wins_premier = 0;
                                
                                sleep(1000).then(() => {
                                    steamClient.sendToGC(appid, 9109, {}, Buffer.alloc(0));
                                });
                                break;
                            }
                            }
                        }
                    }
                    break;
                }
                case 9110: {
                    {
                        //request wingman, dz and premier rank
                        let message = protoEncode(Protos.csgo.CMsgGCCStrike15_v2_ClientGCRankUpdate, { rankings: [ { rank_type_id: 6 }, { rank_type_id: 7 }, { rank_type_id: 10 }, { rank_type_id: 11 } ] });
                        steamClient.sendToGC(appid, 9194, {}, message);
                    }

                    let msg = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_MatchmakingGC2ClientHello, payload);

                    ++attempts;
                    if(msg.ranking === null && attempts < 5 && !msg.vac_banned) {
                        sleep(2000).then(() => {
                            steamClient.sendToGC(appid, 9109, {}, Buffer.alloc(0));
                        });
                    }
                    else {
                        if(!Done) {
                            Done = true;
                            currently_checking = currently_checking.filter(x => x !== username);
                            data.penalty_reason = steamClient.limitations.communityBanned ? 'Community ban' : msg.penalty_reason > 0 ? penalty_reason_string(msg.penalty_reason) : msg.vac_banned ? 'VAC' : 0;
                            data.penalty_seconds = msg.vac_banned || steamClient.limitations.communityBanned || penalty_reason_permanent(msg.penalty_reason) ? -1 : msg.penalty_seconds > 0 ? (Math.floor(Date.now() / 1000) + msg.penalty_seconds) : 0;
                            data.wins = msg.vac_banned ? -1 : attempts < 5 ? msg.ranking.wins : 0;
                            data.rank = msg.vac_banned ? -1 : attempts < 5 ? msg.ranking.rank_id : 0;
                            data.name = steamClient.accountInfo.name;
                            data.lvl = msg.player_level;
                            data.steamid = steamClient.steamID.getSteamID64();
                            data.error = null;
                            
                            // Сохраняем прайм-статус в базе данных
                            let account = db.get(username);
                            if (account) {
                                account.prime = data.prime;
                                db.set(username, account);
                                console.log(`Обновлен прайм-статус для ${username} в базе данных:`, data.prime);
                            }
                            if(data.rank_wg != undefined && data.rank_dz != undefined) {
                                resolve(data);
                                steamClient.logOff();
                            }
                        }
                    }
                    break;
                }
                case 9194: {
                    let msg = protoDecode(Protos.csgo.CMsgGCCStrike15_v2_ClientGCRankUpdate, payload);
                    for (const ranking of msg.rankings) {
                        if(ranking.rank_type_id == 6) { //competitive
                            data.wins = ranking.wins;
                            data.rank = ranking.rank_id;
                            console.log(`Competitive rank для ${username}: ${data.rank}, wins: ${data.wins}`);
                        }
                        if(ranking.rank_type_id == 7) { //wingman
                            data.wins_wg = ranking.wins;
                            data.rank_wg = ranking.rank_id;
                            console.log(`Wingman rank для ${username}: ${data.rank_wg}, wins: ${data.wins_wg}`);
                            if(data.wins === -1) { //vac banned
                                data.wins_wg = -1;
                                data.rank_wg = -1;
                            }
                        }
                        if(ranking.rank_type_id == 10) { //dangerzone
                            data.wins_dz = ranking.wins;
                            data.rank_dz = ranking.rank_id;
                            console.log(`Danger Zone rank для ${username}: ${data.rank_dz}, wins: ${data.wins_dz}`);
                            if(data.wins === -1) { //vac banned
                                data.wins_dz = -1;
                                data.rank_dz = -1;
                            }
                        }
                        if(ranking.rank_type_id == 11) { //premier
                            data.wins_premier = ranking.wins;
                            data.rank_premier = ranking.rank_id;
                            console.log(`Premier rank для ${username}: ${data.rank_premier}, wins: ${data.wins_premier}`);
                            if(data.wins === -1) { //vac banned
                                data.wins_premier = -1;
                                data.rank_premier = -1;
                            }
                        }
                    }
                    
                    // Если у нас есть steamid и хотя бы один ранг, можем завершать
                    if(data.steamid != undefined && 
                      (data.rank != undefined || data.rank_wg != undefined || data.rank_dz != undefined || data.rank_premier != undefined)) {
                        // Очищаем поле error, если проверка прошла успешно
                        data.error = null;
                        Done = true;
                        clearTimeout(timeout);
                        resolve(data);
                        steamClient.logOff();
                    }
                }
            }
            } catch (error) {
                console.error(`Ошибка при обработке сообщения от Game Coordinator для ${username}:`, error);
            }
        });
    });    
}

process.on('uncaughtException', err => {
  console.error('uncaughtException', err);
})
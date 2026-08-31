<img width="100" align="right" alt="icon" src="https://github.com/dumbasPL/csgo-checker/raw/master/build/icon.ico" />

# CS2 account checker

> [!NOTE]  
> Updated for **CS2** (Counter-Strike 2, formerly CS:GO). The Game Coordinator
> flow, Premier rating, profile level/XP and Prime detection have been ported to
> CS2. The npm package name and app id are kept stable for backward compatibility.

[![Github All Releases](https://img.shields.io/github/downloads/dumbasPL/csgo-checker/total.svg?style=for-the-badge)](https://github.com/dumbasPL/csgo-checker/releases/latest)

## Checks CS2 accounts for

- bans (vac/overwatch/untrusted)
- cooldowns (abandon, team damage, etc)
- matchmaking rank/wins/rank expiration time (competitive, wingman and dangerzone)
- Premier rating
- CS2 profile level/XP
- prime status
- steam profile name

Fields that are unknown or unavailable are shown as `N/A`/`Unranked` rather than
stale CS:GO values.

## Additional features

- import/export form/to `user:pass` combo file
- steam guard mobile authenticator shared secrets supported
- mass refresh
- copy password to clipboard
- copy CS2 friend code to clipboard
- copy mobile steam 2fa code to clipboard (requires shared secret to be set)
- search bar
- tags
- sorting
- steam guard protected accounts supported

## Development

This is an [Electron](https://www.electronjs.org/) app. Common scripts:

```sh
npm install       # install dependencies
npm start         # run the app
npm run lint      # run eslint (flat config in eslint.config.js)
npm test          # run the unit tests (node:test, no extra deps)
npm run package   # build an unpacked app directory (electron-builder --dir)
npm run build     # build installers/packages for Windows and Linux
```

> [!NOTE]
> The unit tests cover the pure/offline logic (GCPD HTML parsing, import/export
> parsing, logger redaction, proto encode/decode, the concurrency queue and the
> XP/Prime helpers). Real Steam login and Game Coordinator verification require
> running the Electron app with **real Steam credentials** against live Valve
> servers, which is **not possible in CI** (no display, no credentials). That
> path must be validated manually.

## screenshots
![image](https://user-images.githubusercontent.com/29180158/119862011-56202680-bf18-11eb-97db-229ff5c13535.png)

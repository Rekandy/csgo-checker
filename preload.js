const { contextBridge, ipcRenderer, clipboard, shell } = require("electron");
const equal = require('fast-deep-equal');
const friendCode = require("csgo-friendcode");
var showdown = require('showdown');
const md_converter = new showdown.Converter();
// SECURITY NOTE (showdown XSS/ReDoS advisories, no upstream fix available):
// makeHtml() is only ever fed the application's own bundled changelog.md
// (main.js 'ready' -> 'update:changelog' reads __dirname/changelog.md and is
// the sole emitter; front.js is the sole consumer). No user-, network-, or
// attacker-controlled input reaches showdown, so the reported XSS/ReDoS
// advisories are not reachable in this app. Do not feed untrusted markdown
// through md_converter without first adding output sanitization.

contextBridge.exposeInMainWorld("ipcRenderer", {
  send: (channel, ...args) => {
    // Forward all arguments so multi-arg IPC messages survive the bridge.
    // The Steam Guard response sends (code, username); dropping the username
    // (as a single-arg bridge would) breaks per-account routing under
    // concurrent Steam Guard prompts.
    ipcRenderer.send(channel, ...args);
  },
  on: (channel, func) => {
    ipcRenderer.on(channel, (...args) => func(...args));
  },
  invoke: (chanel, ...args) => {
    return ipcRenderer.invoke(chanel, ...args);
  }
});

contextBridge.exposeInMainWorld('fastEqual', {
  equal: (...args) => equal(...args)
});

contextBridge.exposeInMainWorld('friendCode', {
  encode: (steamId) => friendCode.encode(steamId)
});

contextBridge.exposeInMainWorld('clipboard', {
  writeText: (text, type) => clipboard.writeText(text, type)
});

contextBridge.exposeInMainWorld('shell', {
  openExternal: (url, options) => shell.openExternal(url, options)
});

contextBridge.exposeInMainWorld('md_converter', {
  makeHtml: (markdown) => md_converter.makeHtml(markdown)
});
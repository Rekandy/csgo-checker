const { contextBridge, ipcRenderer, clipboard, shell } = require("electron");
const equal = require('fast-deep-equal');
const friendCode = require("csgo-friendcode");
const { renderMarkdown } = require('./helpers/markdown');
// SECURITY NOTE: markdown rendering is delegated to helpers/markdown.js, which
// uses markdown-it configured with `html: false`. Raw HTML in the markdown
// source is escaped rather than emitted, so the returned string is safe to
// assign to `.modal-body` innerHTML in the renderer. This replaced the former
// `showdown` dependency (unpatched XSS/ReDoS advisories, no upstream fix).

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
  makeHtml: (markdown) => renderMarkdown(markdown)
});
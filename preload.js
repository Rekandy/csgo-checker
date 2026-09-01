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
  // Electron 44 rearchitected the clipboard to the W3C model: clipboard.writeText
  // now returns a Promise. Renderer callers use this fire-and-forget (they do not
  // await it), so guard the returned Promise with a .catch() here - mirroring the
  // shell.openExternal .catch() pattern in main.js - so a rejected clipboard write
  // is handled explicitly instead of surfacing as an unhandled promise rejection.
  // The wrapper still returns the Promise, so awaiting callers keep working.
  writeText: (text) => {
    const result = clipboard.writeText(text);
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        console.error('clipboard.writeText failed', err);
      });
    }
    return result;
  }
});

contextBridge.exposeInMainWorld('shell', {
  openExternal: (url, options) => shell.openExternal(url, options)
});

contextBridge.exposeInMainWorld('md_converter', {
  makeHtml: (markdown) => renderMarkdown(markdown)
});
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

/**
 * Load preload.js with a mocked `electron` module so the contextBridge
 * exposures can be captured and their forwarding behaviour asserted without a
 * live Electron runtime.
 *
 * Returns the map of exposed API objects keyed by their world name, plus the
 * list of calls made to the underlying ipcRenderer.send.
 */
function loadPreloadWithMocks() {
    const exposed = {};
    const sendCalls = [];
    const clipboardCalls = [];

    const mockElectron = {
        contextBridge: {
            exposeInMainWorld: (name, api) => { exposed[name] = api; }
        },
        ipcRenderer: {
            send: (...args) => { sendCalls.push(args); },
            on: () => {},
            invoke: () => Promise.resolve()
        },
        clipboard: { writeText: (...args) => { clipboardCalls.push(args); } },
        shell: { openExternal: () => {} }
    };

    // Intercept require('electron') for the duration of the preload load.
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') return mockElectron;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const preloadPath = path.join(__dirname, '..', 'preload.js');
        delete require.cache[require.resolve(preloadPath)];
        require(preloadPath);
    } finally {
        Module._load = originalLoad;
    }

    return { exposed, sendCalls, clipboardCalls };
}

test('preload send bridge forwards all arguments (not just the first)', () => {
    const { exposed, sendCalls } = loadPreloadWithMocks();
    assert.ok(exposed.ipcRenderer, 'ipcRenderer API should be exposed');

    // Simulate the renderer replying to a Steam Guard prompt with a code AND
    // the per-account username. The bridge must forward both so main.js can
    // route the code to the correct account under concurrent prompts.
    exposed.ipcRenderer.send('steam:steamguard:response', '12345', 'accountB');

    assert.strictEqual(sendCalls.length, 1);
    assert.deepStrictEqual(sendCalls[0], ['steam:steamguard:response', '12345', 'accountB']);
});

test('preload send bridge preserves single-arg calls', () => {
    const { exposed, sendCalls } = loadPreloadWithMocks();
    exposed.ipcRenderer.send('some:channel', { foo: 'bar' });
    assert.strictEqual(sendCalls.length, 1);
    assert.deepStrictEqual(sendCalls[0], ['some:channel', { foo: 'bar' }]);
});

test('preload send bridge forwards a null code plus username (dismiss path)', () => {
    const { exposed, sendCalls } = loadPreloadWithMocks();
    // The renderer's dismiss handler sends (null, username).
    exposed.ipcRenderer.send('steam:steamguard:response', null, 'accountA');
    assert.strictEqual(sendCalls.length, 1);
    assert.deepStrictEqual(sendCalls[0], ['steam:steamguard:response', null, 'accountA']);
});

test('preload clipboard bridge forwards only the text arg (no removed Electron 44 type param)', () => {
    const { exposed, clipboardCalls } = loadPreloadWithMocks();
    assert.ok(exposed.clipboard, 'clipboard API should be exposed');

    // Electron 44 rearchitected clipboard: writeText returns a Promise and the
    // legacy optional `type` second argument was removed. The bridge must
    // forward the single text argument and must NOT pass a second arg, even if
    // a caller mistakenly supplies one.
    exposed.clipboard.writeText('ABCD-1234', 'clipboard');

    assert.strictEqual(clipboardCalls.length, 1);
    assert.deepStrictEqual(clipboardCalls[0], ['ABCD-1234']);
});

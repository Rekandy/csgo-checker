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
 * Accepts an optional `clipboardWriteText` implementation so a test can inject
 * a custom clipboard.writeText (e.g. one that rejects) while reusing the same
 * Module._load interception scaffolding. When omitted, the default mirrors
 * Electron 44's Promise-returning writeText and records its args.
 *
 * Returns the map of exposed API objects keyed by their world name, plus the
 * list of calls made to the underlying ipcRenderer.send.
 */
function loadPreloadWithMocks({ clipboardWriteText } = {}) {
    const exposed = {};
    const sendCalls = [];
    const clipboardCalls = [];

    // Electron 44's clipboard.writeText returns a Promise; the default mock
    // mirrors that so the bridge's .catch() guard is exercised on the resolved
    // path. Tests may inject their own implementation (e.g. a rejecting one).
    const defaultWriteText = (...args) => { clipboardCalls.push(args); return Promise.resolve(); };

    const mockElectron = {
        contextBridge: {
            exposeInMainWorld: (name, api) => { exposed[name] = api; }
        },
        ipcRenderer: {
            send: (...args) => { sendCalls.push(args); },
            on: () => {},
            invoke: () => Promise.resolve()
        },
        clipboard: { writeText: clipboardWriteText || defaultWriteText },
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

test('preload clipboard bridge swallows a rejected write (no unhandled rejection under Electron 44)', async () => {
    const originalConsoleError = console.error;
    const consoleErrorCalls = [];
    console.error = (...args) => { consoleErrorCalls.push(args); };

    const rejection = new Error('clipboard unavailable');
    // Inject a platform clipboard write that rejects under Electron 44, reusing
    // the shared Module._load scaffolding rather than duplicating it.
    const { exposed } = loadPreloadWithMocks({ clipboardWriteText: () => Promise.reject(rejection) });

    try {
        // The bridge attaches its own .catch(); the returned Promise still
        // rejects for any caller that chooses to await it, but the bridge's
        // guard ensures the failure is logged rather than unhandled.
        const returned = exposed.clipboard.writeText('ABCD-1234');
        await assert.rejects(returned, /clipboard unavailable/);
        // Give the bridge's internal .catch() a microtask turn to run.
        await Promise.resolve();
        assert.strictEqual(consoleErrorCalls.length, 1);
        assert.strictEqual(consoleErrorCalls[0][0], 'clipboard.writeText failed');
        assert.strictEqual(consoleErrorCalls[0][1], rejection);
    } finally {
        console.error = originalConsoleError;
    }
});

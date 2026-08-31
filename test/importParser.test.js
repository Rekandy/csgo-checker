'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseAccountLines } = require('../helpers/importParser.js');

test('parses plain user:pass lines', () => {
    const { accounts, skipped } = parseAccountLines('alice:secretpw\nbob:anotherpw');
    assert.strictEqual(skipped, 0);
    assert.deepStrictEqual(accounts, [
        { username: 'alice', password: 'secretpw', sharedSecret: undefined },
        { username: 'bob', password: 'anotherpw', sharedSecret: undefined }
    ]);
});

test('parses user:pass:shared_secret', () => {
    // Synthetic (fake) 28-char base64 shared-secret string ending in '=', used only to
    // exercise the user:pass:shared_secret parser. Not a real credential.
    const secret = 'abcdEFGHijklMNOPqrstUVWXyz0=';
    const { accounts, skipped } = parseAccountLines(`alice:mypassword:${secret}`);
    assert.strictEqual(skipped, 0);
    assert.deepStrictEqual(accounts, [
        { username: 'alice', password: 'mypassword', sharedSecret: secret }
    ]);
});

test('password containing a colon is preserved (no secret)', () => {
    const { accounts, skipped } = parseAccountLines('alice:pa:ss:word');
    assert.strictEqual(skipped, 0);
    // Trailing "word" is not secret-shaped, so the whole remainder is the password.
    assert.deepStrictEqual(accounts, [
        { username: 'alice', password: 'pa:ss:word', sharedSecret: undefined }
    ]);
});

test('password with colon plus trailing shared secret', () => {
    // Synthetic (fake) shared-secret string used only as a parser test fixture. Not a real credential.
    const secret = 'ABCDEFGHIJKLMNOPQRSTUVWX1234';
    const { accounts } = parseAccountLines(`alice:pa:ss:word:${secret}`);
    assert.deepStrictEqual(accounts, [
        { username: 'alice', password: 'pa:ss:word', sharedSecret: secret }
    ]);
});

test('strips a leading UTF-8 BOM', () => {
    const { accounts, skipped } = parseAccountLines('\uFEFFalice:pw');
    assert.strictEqual(skipped, 0);
    assert.strictEqual(accounts[0].username, 'alice');
    assert.strictEqual(accounts[0].password, 'pw');
});

test('handles CRLF line endings', () => {
    const { accounts, skipped } = parseAccountLines('alice:pw1\r\nbob:pw2\r\n');
    assert.strictEqual(skipped, 0);
    assert.strictEqual(accounts.length, 2);
    assert.strictEqual(accounts[0].password, 'pw1');
    assert.strictEqual(accounts[1].password, 'pw2');
});

test('skips blank and whitespace-only lines without throwing', () => {
    const { accounts, skipped } = parseAccountLines('alice:pw\n\n   \n\t\nbob:pw2\n');
    // Blank/whitespace lines are not counted as skipped (they are not malformed).
    assert.strictEqual(skipped, 0);
    assert.strictEqual(accounts.length, 2);
});

test('skips garbage line with no colon instead of throwing', () => {
    const { accounts, skipped } = parseAccountLines('alice:pw\nthisisgarbage\nbob:pw2');
    assert.strictEqual(skipped, 1);
    assert.strictEqual(accounts.length, 2);
    assert.deepStrictEqual(accounts.map(a => a.username), ['alice', 'bob']);
});

test('skips lines with empty username or empty password', () => {
    const { accounts, skipped } = parseAccountLines(':pw\nalice:\ngood:pw');
    assert.strictEqual(skipped, 2);
    assert.strictEqual(accounts.length, 1);
    assert.strictEqual(accounts[0].username, 'good');
});

test('de-duplicates by username, last one wins', () => {
    const { accounts, skipped } = parseAccountLines('alice:old\nbob:pw\nalice:new');
    assert.strictEqual(skipped, 0);
    assert.strictEqual(accounts.length, 2);
    const alice = accounts.find(a => a.username === 'alice');
    assert.strictEqual(alice.password, 'new');
});

test('valid lines still parse when interleaved with bad ones', () => {
    const text = 'alice:pw1\ngarbage\n\nbob:pw2\n:emptyuser\ncarol:pw3';
    const { accounts, skipped } = parseAccountLines(text);
    assert.strictEqual(skipped, 2); // "garbage" and ":emptyuser"
    assert.deepStrictEqual(accounts.map(a => a.username), ['alice', 'bob', 'carol']);
});

test('non-string input returns empty result without throwing', () => {
    assert.deepStrictEqual(parseAccountLines(null), { accounts: [], skipped: 0 });
    assert.deepStrictEqual(parseAccountLines(undefined), { accounts: [], skipped: 0 });
    assert.deepStrictEqual(parseAccountLines(42), { accounts: [], skipped: 0 });
});

test('parses a large input (5000 lines) quickly', () => {
    const lines = [];
    for (let i = 0; i < 5000; i++) {
        lines.push(`user${i}:pass${i}`);
    }
    const start = Date.now();
    const { accounts, skipped } = parseAccountLines(lines.join('\n'));
    const elapsed = Date.now() - start;
    assert.strictEqual(skipped, 0);
    assert.strictEqual(accounts.length, 5000);
    assert.ok(elapsed < 2000, `parsing 5000 lines took too long: ${elapsed}ms`);
});

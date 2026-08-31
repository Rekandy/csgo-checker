'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EncryptedStorage = require('../EncryptedStorage.js');

/**
 * Create a fresh temp directory for a test.
 * @returns {string}
 */
function mkTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'encstore-'));
}

/**
 * Open an EncryptedStorage and resolve once it has emitted 'loaded' or 'error'.
 * @param {string} filePath
 * @param {string} password
 * @param {object} [options]
 * @returns {Promise<{db: EncryptedStorage, event: string, error: Error|null}>}
 */
function open(filePath, password, options) {
    return new Promise((resolve) => {
        const db = new EncryptedStorage(filePath, password, options);
        db.once('loaded', () => resolve({ db, event: 'loaded', error: null }));
        db.once('error', (err) => resolve({ db, event: 'error', error: err }));
    });
}

test('(a)+(b) round-trip: create, set, sync, reopen with same password', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');

    const first = await open(file, 'correct horse', { newData: {} });
    assert.strictEqual(first.event, 'loaded');
    first.db.set('alice', { steamid: '123', rank: 5 });
    first.db.set('bob', { steamid: '456', rank: 10 });
    first.db.sync();

    const second = await open(file, 'correct horse');
    assert.strictEqual(second.event, 'loaded');
    assert.deepStrictEqual(second.db.get('alice'), { steamid: '123', rank: 5 });
    assert.deepStrictEqual(second.db.get('bob'), { steamid: '456', rank: 10 });
});

test('(c) wrong password emits error and leaves file byte-identical', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');

    const first = await open(file, 'right-password', { newData: { k: 'v' } });
    assert.strictEqual(first.event, 'loaded');
    first.db.sync();

    const before = fs.readFileSync(file);

    const wrong = await open(file, 'totally-wrong-password');
    assert.strictEqual(wrong.event, 'error', 'wrong password must emit error');

    const after = fs.readFileSync(file);
    assert.ok(before.equals(after), 'file must be byte-identical after a wrong-password attempt');
});

test('(d) corrupted ciphertext emits error, does not crash or wipe file', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');

    const first = await open(file, 'pw', { newData: { hello: 'world' } });
    assert.strictEqual(first.event, 'loaded');
    first.db.sync();

    // Corrupt the ciphertext but keep the {iv,salt,data} JSON structure intact.
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.data = 'bm90LXZhbGlkLWNpcGhlcnRleHQ=';
    fs.writeFileSync(file, JSON.stringify(parsed));
    const before = fs.readFileSync(file);

    const res = await open(file, 'pw');
    assert.strictEqual(res.event, 'error', 'corrupted ciphertext must emit error');

    const after = fs.readFileSync(file);
    assert.ok(before.equals(after), 'corrupted file must not be wiped/overwritten');
});

test('(d2) truncated / non-JSON file emits error, no crash, not wiped', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');

    fs.writeFileSync(file, '{ this is not valid json');
    const before = fs.readFileSync(file);

    const res = await open(file, 'pw');
    assert.strictEqual(res.event, 'error');

    const after = fs.readFileSync(file);
    assert.ok(before.equals(after), 'truncated file must remain intact');
});

test('(d3) zero-byte existing file loads as empty without crashing', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');

    fs.writeFileSync(file, '');
    const res = await open(file, 'pw');
    assert.strictEqual(res.event, 'loaded', 'zero-byte file should load as empty');
    assert.strictEqual(res.db.get('anything'), undefined);
});

test('(e) sync uses atomic replace: no leftover .tmp on success', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');

    const res = await open(file, 'pw', { newData: {} });
    assert.strictEqual(res.event, 'loaded');
    res.db.set('key', 'value');
    res.db.sync();

    assert.ok(fs.existsSync(file), 'target file must exist after sync');
    assert.ok(!fs.existsSync(file + '.tmp'), 'no leftover .tmp file after a successful sync');
});

test('backward-compat: decrypts a pre-recorded {iv,salt,data} blob with the correct password', async () => {
    // This blob was written by EncryptedStorage.sync() using the storage scheme
    // (pbkdf2 sha256, 200000 rounds, aes-256-cbc, {iv,salt,data} on disk). It is
    // hard-coded here so that any future change to the key-derivation params or
    // to the pbkdf2 dependency that breaks decryption of already-written account
    // databases will fail this test rather than silently locking users out.
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');
    const blob = '{"iv":"8a465c30b1bcaf2e828146467c16a660","salt":"0mTblJGc14Ey","data":"/tkYulVmY+D+EedfAPMJ+b2XQbgC9Lr1OR0y7jq0DnZr6jzFrTyPcIeLQYLwdsnwf1bNMxCdgkR+dczXzN16cDbZlUTTyfFGVKbAR8wTN9dtDcM+AwZ1l/BN78TS9E2dd+44+e0g0mjQqL30jdgaFE3nX7wsSlkgGACIOqri8pFfzlnXwzUOT/fh63R4BJjSHopDjl90N/lVdzZ4zLkoPB2XxL5Bbhu00nUOjYZ3u1E="}';
    fs.writeFileSync(file, blob);

    const res = await open(file, 'fixture-password-v1');
    assert.strictEqual(res.event, 'loaded', 'stored blob must decrypt with the correct password');
    assert.deepStrictEqual(res.db.get('alice'), { steamid: '76561198000000001', rank: 18 });
    assert.deepStrictEqual(res.db.get('bob'), { steamid: '76561198000000002', rank: 0 });
});

test('backward-compat: pre-recorded blob rejects a wrong password without wiping', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');
    const blob = '{"iv":"8a465c30b1bcaf2e828146467c16a660","salt":"0mTblJGc14Ey","data":"/tkYulVmY+D+EedfAPMJ+b2XQbgC9Lr1OR0y7jq0DnZr6jzFrTyPcIeLQYLwdsnwf1bNMxCdgkR+dczXzN16cDbZlUTTyfFGVKbAR8wTN9dtDcM+AwZ1l/BN78TS9E2dd+44+e0g0mjQqL30jdgaFE3nX7wsSlkgGACIOqri8pFfzlnXwzUOT/fh63R4BJjSHopDjl90N/lVdzZ4zLkoPB2XxL5Bbhu00nUOjYZ3u1E="}';
    fs.writeFileSync(file, blob);
    const before = fs.readFileSync(file);

    const res = await open(file, 'not-the-fixture-password');
    assert.strictEqual(res.event, 'error', 'wrong password against the stored blob must emit error');

    const after = fs.readFileSync(file);
    assert.ok(before.equals(after), 'stored blob must remain byte-identical after a wrong-password attempt');
});

test('on-disk format stays {iv,salt,data} for backward compatibility', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'db.json');

    const res = await open(file, 'pw', { newData: { a: 1 } });
    assert.strictEqual(res.event, 'loaded');
    res.db.sync();

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(Object.keys(onDisk).sort(), ['data', 'iv', 'salt']);
    assert.strictEqual(typeof onDisk.iv, 'string');
    assert.strictEqual(typeof onDisk.salt, 'string');
    assert.strictEqual(typeof onDisk.data, 'string');
});

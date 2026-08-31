'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const logger = require('../helpers/logger.js');

test('redact masks secret-looking keys at the top level', () => {
    const out = logger.redact({
        username: 'alice',
        password: 'hunter2',
        sharedSecret: 'abc123',
        shared_secret: 'def456',
        token: 't0ken',
        authToken: 'a',
        cookie: 'sessionid=xyz',
        op: 'login',
        rank: 5
    });
    assert.strictEqual(out.username, 'alice');
    assert.strictEqual(out.password, '[REDACTED]');
    assert.strictEqual(out.sharedSecret, '[REDACTED]');
    assert.strictEqual(out.shared_secret, '[REDACTED]');
    assert.strictEqual(out.token, '[REDACTED]');
    assert.strictEqual(out.authToken, '[REDACTED]');
    assert.strictEqual(out.cookie, '[REDACTED]');
    // Non-secret keys are left untouched.
    assert.strictEqual(out.op, 'login');
    assert.strictEqual(out.rank, 5);
});

test('redact masks secrets in nested objects and arrays', () => {
    const out = logger.redact({
        account: 'bob',
        session: { cookie: 'c', nested: { password: 'p', name: 'keep' } },
        list: [
            { token: 'x', op: 'check' },
            { sharedSecret: 'y', rank: 10 }
        ]
    });
    assert.strictEqual(out.account, 'bob');
    assert.strictEqual(out.session.cookie, '[REDACTED]');
    assert.strictEqual(out.session.nested.password, '[REDACTED]');
    assert.strictEqual(out.session.nested.name, 'keep');
    assert.strictEqual(out.list[0].token, '[REDACTED]');
    assert.strictEqual(out.list[0].op, 'check');
    assert.strictEqual(out.list[1].sharedSecret, '[REDACTED]');
    assert.strictEqual(out.list[1].rank, 10);
});

test('redact leaves account/op/rank untouched', () => {
    const out = logger.redact({ account: 'a', op: 'export', rank: 3 });
    assert.deepStrictEqual(out, { account: 'a', op: 'export', rank: 3 });
});

test('redact scans free-form strings for inline secrets', () => {
    assert.strictEqual(logger.redact('password=hunter2'), 'password=[REDACTED]');
    assert.strictEqual(logger.redact('token: abc123'), 'token: [REDACTED]');
    assert.ok(logger.redact('the cookie => sessionid').includes('[REDACTED]'));
});

test('redact handles primitives and circular references', () => {
    assert.strictEqual(logger.redact(5), 5);
    assert.strictEqual(logger.redact(null), null);
    assert.strictEqual(logger.redact(undefined), undefined);
    const obj = { name: 'x' };
    obj.self = obj;
    const out = logger.redact(obj);
    assert.strictEqual(out.name, 'x');
    assert.strictEqual(out.self, '[Circular]');
});

test('redact scrubs Error objects including secret props', () => {
    const err = new Error('boom password=secret');
    err.token = 'leaky';
    const out = logger.redact(err);
    assert.ok(out.message.includes('[REDACTED]'));
    assert.strictEqual(out.token, '[REDACTED]');
});

test('level filtering suppresses DEBUG when level is INFO', () => {
    const original = logger.getLevel();
    const logged = [];
    const origLog = console.log;
    console.log = (...args) => logged.push(args);
    try {
        logger.setLevel('INFO');
        logger.debug('should not appear', { account: 'a' });
        assert.strictEqual(logged.length, 0, 'DEBUG must be suppressed at INFO level');

        logger.info('should appear', { account: 'a' });
        assert.strictEqual(logged.length, 1, 'INFO must be emitted at INFO level');
    } finally {
        console.log = origLog;
        logger.setLevel(original);
    }
});

test('level filtering allows DEBUG when level is DEBUG', () => {
    const original = logger.getLevel();
    const logged = [];
    const origLog = console.log;
    console.log = (...args) => logged.push(args);
    try {
        logger.setLevel('DEBUG');
        logger.debug('now visible', { account: 'a' });
        assert.strictEqual(logged.length, 1);
    } finally {
        console.log = origLog;
        logger.setLevel(original);
    }
});

test('log redacts secrets passed via context', () => {
    const original = logger.getLevel();
    const logged = [];
    const origLog = console.log;
    console.log = (...args) => logged.push(args);
    try {
        logger.setLevel('INFO');
        logger.info('checking', { account: 'a', password: 'p', sharedSecret: 's' });
        const ctx = logged[0][2];
        assert.strictEqual(ctx.account, 'a');
        assert.strictEqual(ctx.password, '[REDACTED]');
        assert.strictEqual(ctx.sharedSecret, '[REDACTED]');
    } finally {
        console.log = origLog;
        logger.setLevel(original);
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TaskQueue } = require('../helpers/queue.js');

// A tiny async yield so tasks actually overlap without long delays.
const tick = () => new Promise((r) => setImmediate(r));

test('concurrency is never exceeded and all tasks resolve', async () => {
    const q = new TaskQueue(2);
    let active = 0;
    let peak = 0;
    const results = [];

    const make = (i) => q.add(async () => {
        active++;
        peak = Math.max(peak, active);
        // A couple of yields so overlapping tasks are observable.
        await tick();
        await tick();
        active--;
        return i;
    });

    const values = await Promise.all([0, 1, 2, 3, 4, 5].map(make));

    assert.ok(peak <= 2, `peak concurrency ${peak} must not exceed 2`);
    assert.ok(peak >= 2, `expected concurrency to reach 2, got ${peak}`);
    for (const v of values) results.push(v);
    assert.deepStrictEqual(results.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test('a throwing task does not prevent the others from completing', async () => {
    const q = new TaskQueue(2);
    const outcomes = [];

    const good = (i) => q.add(async () => {
        await tick();
        return i;
    }).then((v) => outcomes.push(`ok:${v}`));

    const bad = () => q.add(async () => {
        await tick();
        throw new Error('boom');
    }).then(
        () => outcomes.push('unexpected-ok'),
        (e) => outcomes.push(`err:${e.message}`)
    );

    const syncThrow = () => q.add(() => {
        throw new Error('sync-boom');
    }).then(
        () => outcomes.push('unexpected-sync-ok'),
        (e) => outcomes.push(`err:${e.message}`)
    );

    await Promise.all([good(1), bad(), good(2), syncThrow(), good(3)]);

    assert.ok(outcomes.includes('ok:1'));
    assert.ok(outcomes.includes('ok:2'));
    assert.ok(outcomes.includes('ok:3'));
    assert.ok(outcomes.includes('err:boom'));
    assert.ok(outcomes.includes('err:sync-boom'));
    assert.ok(!outcomes.includes('unexpected-ok'));
    assert.ok(!outcomes.includes('unexpected-sync-ok'));
});

test('onIdle/drain resolves only after all tasks settle', async () => {
    const q = new TaskQueue(2);
    let settled = 0;

    for (let i = 0; i < 5; i++) {
        q.add(async () => {
            await tick();
            settled++;
            if (i === 2) throw new Error('one failure among many');
        }).catch(() => { /* isolated, ignore */ });
    }

    await q.onIdle();
    assert.strictEqual(settled, 5, 'all five tasks must have settled before drain resolves');
    assert.strictEqual(q.running, 0);
    assert.strictEqual(q.pending, 0);
});

test('onIdle resolves immediately when the queue is empty', async () => {
    const q = new TaskQueue(3);
    await q.onIdle();
    assert.ok(true);
});

test('concurrency below 1 is clamped to 1', async () => {
    const q = new TaskQueue(0);
    assert.strictEqual(q.concurrency, 1);
    let active = 0;
    let peak = 0;
    await Promise.all([1, 2, 3].map(() => q.add(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
    })));
    assert.strictEqual(peak, 1);
});

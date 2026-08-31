'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { CS2_XP_BASE, CS2_XP_PER_LEVEL, xpIntoLevel, xpModuloLevel } = require('../helpers/xp.js');

// --- constants --------------------------------------------------------------

test('CS2 XP constants keep their exact documented values', () => {
    assert.strictEqual(CS2_XP_BASE, 327680000);
    assert.strictEqual(CS2_XP_PER_LEVEL, 5000);
});

// --- xpIntoLevel (guarded accountmain form) ---------------------------------

test('xpIntoLevel returns raw xp when at or below the base', () => {
    // rawXp below base
    assert.strictEqual(xpIntoLevel(0), 0);
    assert.strictEqual(xpIntoLevel(4200), 4200);
    // rawXp exactly base (not strictly greater) -> returned unchanged
    assert.strictEqual(xpIntoLevel(CS2_XP_BASE), CS2_XP_BASE);
});

test('xpIntoLevel converts raw absolute xp just above the base', () => {
    // rawXp just above base -> (rawXp - base) % 5000
    assert.strictEqual(xpIntoLevel(CS2_XP_BASE + 1), 1);
    assert.strictEqual(xpIntoLevel(CS2_XP_BASE + 5000), 0);
    assert.strictEqual(xpIntoLevel(CS2_XP_BASE + 5001), 1);
});

test('xpIntoLevel handles a large raw value', () => {
    const raw = CS2_XP_BASE + 123456;
    assert.strictEqual(xpIntoLevel(raw), 123456 % 5000);
    assert.ok(xpIntoLevel(raw) >= 0);
    assert.ok(xpIntoLevel(raw) < CS2_XP_PER_LEVEL);
});

// --- xpModuloLevel (always-subtract PlayersProfile form) --------------------

test('xpModuloLevel clamps values below the base to 0', () => {
    // rawXp below base -> into clamped to 0 -> 0 % 5000 === 0
    assert.strictEqual(xpModuloLevel(0), 0);
    assert.strictEqual(xpModuloLevel(4200), 0);
    // rawXp exactly base -> 0
    assert.strictEqual(xpModuloLevel(CS2_XP_BASE), 0);
});

test('xpModuloLevel subtracts base and takes modulo for values above base', () => {
    assert.strictEqual(xpModuloLevel(CS2_XP_BASE + 1), 1);
    assert.strictEqual(xpModuloLevel(CS2_XP_BASE + 5000), 0);
    const raw = CS2_XP_BASE + 987654;
    assert.strictEqual(xpModuloLevel(raw), 987654 % 5000);
    assert.ok(xpModuloLevel(raw) >= 0);
    assert.ok(xpModuloLevel(raw) < CS2_XP_PER_LEVEL);
});

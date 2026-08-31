'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    STATUS,
    statusFromEresult,
    isNonRetryableStatus,
    shouldRetry,
    backoffDelay
} = require('../helpers/checker.js');

test('statusFromEresult maps known EResults', () => {
    assert.strictEqual(statusFromEresult(5), STATUS.INVALID_CREDENTIALS);
    assert.strictEqual(statusFromEresult(84), STATUS.RATE_LIMITED);
    assert.strictEqual(statusFromEresult(6), STATUS.DISCONNECTED);
    assert.strictEqual(statusFromEresult(34), STATUS.DISCONNECTED);
    assert.strictEqual(statusFromEresult(65), STATUS.STEAM_GUARD_REQUIRED);
    assert.strictEqual(statusFromEresult(63), STATUS.STEAM_GUARD_REQUIRED);
    // Unknown / transient errors classify as generic error.
    assert.strictEqual(statusFromEresult(2), STATUS.ERROR);
    assert.strictEqual(statusFromEresult(18), STATUS.ERROR);
    assert.strictEqual(statusFromEresult(undefined), STATUS.ERROR);
});

test('invalid_credentials and steam_guard_required are non-retryable', () => {
    assert.strictEqual(isNonRetryableStatus(STATUS.INVALID_CREDENTIALS), true);
    assert.strictEqual(isNonRetryableStatus(STATUS.STEAM_GUARD_REQUIRED), true);

    assert.strictEqual(shouldRetry({ attempt: 1, maxAttempts: 3, status: STATUS.INVALID_CREDENTIALS }), false);
    assert.strictEqual(shouldRetry({ attempt: 1, maxAttempts: 3, status: STATUS.STEAM_GUARD_REQUIRED }), false);
});

test('rate_limited and transient/disconnect are retryable up to the cap', () => {
    assert.strictEqual(isNonRetryableStatus(STATUS.RATE_LIMITED), false);
    assert.strictEqual(isNonRetryableStatus(STATUS.DISCONNECTED), false);
    assert.strictEqual(isNonRetryableStatus(STATUS.ERROR), false);

    // Below the cap -> retry.
    assert.strictEqual(shouldRetry({ attempt: 1, maxAttempts: 3, status: STATUS.RATE_LIMITED }), true);
    assert.strictEqual(shouldRetry({ attempt: 2, maxAttempts: 3, status: STATUS.DISCONNECTED }), true);
    assert.strictEqual(shouldRetry({ attempt: 1, maxAttempts: 3, status: STATUS.ERROR }), true);

    // At/over the cap -> no more retries (no infinite loop).
    assert.strictEqual(shouldRetry({ attempt: 3, maxAttempts: 3, status: STATUS.ERROR }), false);
    assert.strictEqual(shouldRetry({ attempt: 5, maxAttempts: 3, status: STATUS.RATE_LIMITED }), false);
});

test('backoff grows with attempts and is bounded by maxDelay', () => {
    // random=1 gives the full (deterministic) delay for this jitter scheme.
    const opts = { baseDelay: 2000, maxDelay: 60000, random: () => 1 };

    const d1 = backoffDelay({ attempt: 1, status: STATUS.ERROR, ...opts });
    const d2 = backoffDelay({ attempt: 2, status: STATUS.ERROR, ...opts });
    const d3 = backoffDelay({ attempt: 3, status: STATUS.ERROR, ...opts });

    assert.strictEqual(d1, 2000);
    assert.strictEqual(d2, 4000);
    assert.strictEqual(d3, 8000);
    assert.ok(d2 > d1 && d3 > d2, 'backoff must grow with attempts');

    // Large attempt counts stay bounded (no overflow to Infinity).
    const dHuge = backoffDelay({ attempt: 100, status: STATUS.ERROR, ...opts });
    assert.ok(dHuge <= 60000 && Number.isFinite(dHuge), 'backoff must be bounded and finite');
});

test('rate_limited backs off longer than a transient error', () => {
    const opts = { baseDelay: 2000, rateLimitedBaseDelay: 30000, maxDelay: 120000, random: () => 1 };
    const transient = backoffDelay({ attempt: 1, status: STATUS.ERROR, ...opts });
    const rateLimited = backoffDelay({ attempt: 1, status: STATUS.RATE_LIMITED, ...opts });
    assert.ok(rateLimited > transient, 'rate_limited must back off longer');
    assert.strictEqual(rateLimited, 30000);
});

test('backoff jitter stays within [0, capped]', () => {
    // random=0 yields the minimum (0); the value is always >= 0 and finite.
    const d = backoffDelay({ attempt: 3, status: STATUS.ERROR, baseDelay: 2000, maxDelay: 60000, random: () => 0 });
    assert.strictEqual(d, 0);
    // A mid jitter value stays under the exponential cap for the attempt.
    const mid = backoffDelay({ attempt: 3, status: STATUS.ERROR, baseDelay: 2000, maxDelay: 60000, random: () => 0.5 });
    assert.ok(mid >= 0 && mid <= 8000);
});

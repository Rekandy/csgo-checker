'use strict';

/**
 * Pure, testable helpers for the account checker's state machine and retry
 * policy. These functions have NO dependency on steam-user, the network, or
 * Electron so they can be unit-tested without a live Steam connection.
 */

/**
 * Explicit per-account status set. Stored on the account object under
 * `account.status` and forwarded to the renderer. Backward compatible: this is
 * a new field, existing fields are untouched.
 * @enum {string}
 */
const STATUS = Object.freeze({
    IDLE: 'idle',
    LOGGING_IN: 'logging_in',
    LOGGED_IN: 'logged_in',
    CHECKING: 'checking',
    SUCCESS: 'success',
    ERROR: 'error',
    RATE_LIMITED: 'rate_limited',
    INVALID_CREDENTIALS: 'invalid_credentials',
    STEAM_GUARD_REQUIRED: 'steam_guard_required',
    DISCONNECTED: 'disconnected'
});

/**
 * Map a steam-user EResult to one of the STATUS values.
 *
 * Known mappings:
 *  - 5           -> invalid_credentials
 *  - 84          -> rate_limited
 *  - 6, 34       -> disconnected (logged in elsewhere / already logged on)
 *  - 65, 63      -> steam_guard_required
 *  - anything else (2, 18, transient, network) -> error
 *
 * @param {number|undefined|null} eresult the EResult reported by steam-user
 * @returns {string} a STATUS value
 */
function statusFromEresult(eresult) {
    switch (Number(eresult)) {
        case 5:
            return STATUS.INVALID_CREDENTIALS;
        case 84:
            return STATUS.RATE_LIMITED;
        case 6:
        case 34:
            return STATUS.DISCONNECTED;
        case 63:
        case 65:
        case 66:
        case 85:
            return STATUS.STEAM_GUARD_REQUIRED;
        default:
            return STATUS.ERROR;
    }
}

/**
 * Whether a given status is a terminal, non-retryable failure. Invalid
 * credentials and Steam Guard prompts must fail fast: retrying will never
 * succeed without user intervention.
 * @param {string} status a STATUS value
 * @returns {boolean}
 */
function isNonRetryableStatus(status) {
    return status === STATUS.INVALID_CREDENTIALS ||
        status === STATUS.STEAM_GUARD_REQUIRED;
}

/**
 * Decide whether another attempt should be made for a failed check.
 *
 * Non-retryable statuses (invalid_credentials, steam_guard_required) never
 * retry. Everything else (rate_limited, disconnected, generic error/transient)
 * retries until the hard attempt cap is reached.
 *
 * @param {object} params
 * @param {number} params.attempt 1-based number of the attempt that just failed
 * @param {number} params.maxAttempts hard cap on total attempts
 * @param {string} params.status the STATUS classification of the failure
 * @returns {boolean} true if another attempt should be scheduled
 */
function shouldRetry({ attempt, maxAttempts, status }) {
    if (isNonRetryableStatus(status)) {
        return false;
    }
    return attempt < maxAttempts;
}

/**
 * Compute the backoff delay (ms) before the next attempt.
 *
 * Uses exponential growth (base * 2^(attempt-1)) with full jitter, clamped to
 * `maxDelay`. rate_limited failures use a larger base delay because Steam's
 * rate limit needs a longer cooldown. The returned value is always finite and
 * within [0, maxDelay].
 *
 * @param {object} params
 * @param {number} params.attempt 1-based number of the attempt that just failed
 * @param {string} [params.status] the STATUS classification of the failure
 * @param {number} [params.baseDelay=2000] base delay in ms for transient errors
 * @param {number} [params.rateLimitedBaseDelay=30000] base delay for rate_limited
 * @param {number} [params.maxDelay=60000] upper bound on the delay
 * @param {() => number} [params.random=Math.random] jitter source (for tests)
 * @returns {number} delay in milliseconds
 */
function backoffDelay({
    attempt,
    status,
    baseDelay = 2000,
    rateLimitedBaseDelay = 30000,
    maxDelay = 60000,
    random = Math.random
} = {}) {
    const base = status === STATUS.RATE_LIMITED ? rateLimitedBaseDelay : baseDelay;
    const exp = Math.max(0, Number(attempt) - 1);
    // Cap the exponent so 2^exp cannot overflow into Infinity for large attempt
    // counts before the maxDelay clamp is applied.
    const safeExp = Math.min(exp, 30);
    const uncapped = base * Math.pow(2, safeExp);
    const capped = Math.min(uncapped, maxDelay);
    // Full jitter: a random point in [0, capped]. Still bounded by maxDelay.
    const jittered = capped * random();
    return Math.min(Math.max(0, Math.floor(jittered)), maxDelay);
}

module.exports = {
    STATUS,
    statusFromEresult,
    isNonRetryableStatus,
    shouldRetry,
    backoffDelay
};

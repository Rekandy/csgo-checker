'use strict';

/**
 * Structured logger with secret redaction.
 *
 * Levels (in ascending severity): DEBUG, INFO, WARN, ERROR. The active level is
 * resolved once at module load from the environment (see resolveLevel) and can
 * be overridden at runtime via setLevel(). Any message below the active level
 * is suppressed.
 *
 * CRITICAL: this logger never emits secrets. Every context object and every
 * string argument is passed through redact() before being written, so keys such
 * as password, sharedSecret/shared_secret, session/auth tokens and cookies are
 * replaced with '[REDACTED]'. Callers do not need to sanitize their arguments.
 */

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

// Keys whose values must always be masked, matched case-insensitively.
const SECRET_KEY_RE = /pass(word)?|secret|token|cookie|auth/i;

// Best-effort scan for secrets embedded inside free-form strings. This catches
// patterns like "password=hunter2", "token: abc", "sharedSecret => xyz".
const SECRET_STRING_RE =
    /((?:pass(?:word)?|secret|token|cookie|auth)\w*)(\s*[:=]+\s*|\s+)(\S+)/gi;

const REDACTED = '[REDACTED]';

/**
 * Resolve the active log level from the environment.
 * - LOG_LEVEL env var wins if it names a known level.
 * - Otherwise DEBUG when running in an Electron dev build (best effort), else INFO.
 * @returns {string} one of DEBUG|INFO|WARN|ERROR
 */
function resolveLevel() {
    const fromEnv = (process.env.LOG_LEVEL || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(LEVELS, fromEnv)) {
        return fromEnv;
    }
    let isDev = false;
    try {
        // electron-is-dev throws outside of Electron; treat that as non-dev.
        isDev = !!require('electron-is-dev');
    } catch {
        isDev = false;
    }
    return isDev ? 'DEBUG' : 'INFO';
}

let currentLevel = resolveLevel();

/**
 * Override the active log level. Unknown values are ignored.
 * @param {string} level
 */
function setLevel(level) {
    const normalized = (level || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(LEVELS, normalized)) {
        currentLevel = normalized;
    }
}

/** @returns {string} the active log level */
function getLevel() {
    return currentLevel;
}

/**
 * Redact secrets from a value of any shape.
 *
 * - Objects: any key matching SECRET_KEY_RE has its value replaced with
 *   '[REDACTED]'; other values are redacted recursively.
 * - Arrays: each element is redacted recursively.
 * - Strings: a best-effort scan masks inline "key: value" secret pairs.
 * - Other primitives are returned unchanged.
 *
 * Circular references are handled safely.
 *
 * @param {*} value
 * @param {WeakSet} [seen] internal cycle guard
 * @returns {*} a redacted copy (primitives returned as-is)
 */
function redact(value, seen = new WeakSet()) {
    if (typeof value === 'string') {
        return redactString(value);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => redact(item, seen));
    }

    // Errors: preserve the message/stack (scrubbed) without losing them to a
    // plain object copy that would drop non-enumerable props.
    if (value instanceof Error) {
        const copy = { name: value.name, message: redactString(String(value.message)) };
        if (value.stack) {
            copy.stack = redactString(String(value.stack));
        }
        for (const key of Object.keys(value)) {
            copy[key] = SECRET_KEY_RE.test(key) ? REDACTED : redact(value[key], seen);
        }
        return copy;
    }

    const out = {};
    for (const key of Object.keys(value)) {
        if (SECRET_KEY_RE.test(key)) {
            out[key] = REDACTED;
        } else {
            out[key] = redact(value[key], seen);
        }
    }
    return out;
}

/**
 * Mask inline secret assignments found within a free-form string.
 * @param {string} str
 * @returns {string}
 */
function redactString(str) {
    return str.replace(SECRET_STRING_RE, (_match, key, sep) => `${key}${sep}${REDACTED}`);
}

/**
 * Core log function. Filters by level, redacts every argument, and writes to
 * the appropriate console stream.
 * @param {string} level DEBUG|INFO|WARN|ERROR
 * @param {string} message human readable message
 * @param {object} [context] structured context (redacted before output)
 */
function log(level, message, context) {
    const normalized = (level || '').trim().toUpperCase();
    const levelValue = LEVELS[normalized];
    if (levelValue === undefined || levelValue < LEVELS[currentLevel]) {
        return;
    }

    const parts = [`[${normalized}]`, redactString(String(message))];
    if (context !== undefined) {
        parts.push(redact(context));
    }

    if (levelValue >= LEVELS.ERROR) {
        console.error(...parts);
    } else if (levelValue >= LEVELS.WARN) {
        console.warn(...parts);
    } else {
        console.log(...parts);
    }
}

const debug = (message, context) => log('DEBUG', message, context);
const info = (message, context) => log('INFO', message, context);
const warn = (message, context) => log('WARN', message, context);
const error = (message, context) => log('ERROR', message, context);

module.exports = {
    log,
    debug,
    info,
    warn,
    error,
    redact,
    setLevel,
    getLevel,
    LEVELS
};

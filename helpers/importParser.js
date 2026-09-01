'use strict';

/**
 * Robust import parser for account list files.
 *
 * Supported line formats:
 *   username:password
 *   username:password:shared_secret
 *
 * The parser is deliberately forgiving: a single malformed line is skipped
 * (counted in `skipped`) and never throws or aborts the whole import.
 */

// A shared secret is a base32/base64-ish token. Steam mobile shared secrets are
// base64 (28 chars, ending in '='). We accept a reasonably wide match so we can
// distinguish a trailing secret field from a password that merely contains ':'.
const SHARED_SECRET_RE = /^[A-Za-z0-9+/=]{20,}$/;

/**
 * Parse a whole file's text into account entries.
 *
 * Handles: leading UTF-8 BOM, CRLF and LF line endings, trailing whitespace,
 * empty/whitespace-only lines (skipped), passwords containing ':', and an
 * optional trailing shared secret. De-duplicates by username (last one wins).
 *
 * @param {string} text raw file contents
 * @returns {{accounts: Array<{username: string, password: string, sharedSecret: (string|undefined)}>, skipped: number}}
 */
function parseAccountLines(text) {
    if (typeof text !== 'string') {
        return { accounts: [], skipped: 0 };
    }

    // Strip a leading UTF-8 BOM if present.
    if (text.codePointAt(0) === 0xfeff) {
        text = text.slice(1);
    }

    let skipped = 0;
    // Preserve last-one-wins ordering while de-duplicating by username.
    const byUsername = new Map();

    // Split on LF; strip any trailing CR so CRLF and LF both work.
    const lines = text.split('\n');
    for (let raw of lines) {
        // Strip a single trailing CR (CRLF split leaves one). Any additional
        // trailing CRs are whitespace and get removed by the .trim() below, so a
        // non-backtracking single-char anchor is sufficient (and avoids the
        // super-linear `\r+$` quantifier).
        const line = raw.replace(/\r$/, '').trim();
        if (line.length === 0) {
            // Blank or whitespace-only line: not an error, just skip silently.
            continue;
        }

        const parsed = parseLine(line);
        if (parsed === null) {
            skipped++;
            continue;
        }
        byUsername.set(parsed.username, parsed);
    }

    return { accounts: Array.from(byUsername.values()), skipped };
}

/**
 * Parse a single already-trimmed, non-empty line.
 * @param {string} line
 * @returns {({username: string, password: string, sharedSecret: (string|undefined)})|null} null when malformed
 */
function parseLine(line) {
    const firstColon = line.indexOf(':');
    if (firstColon <= 0) {
        // No colon at all, or a leading colon (empty username): malformed.
        return null;
    }

    const username = line.slice(0, firstColon);
    const remainder = line.slice(firstColon + 1);

    if (remainder.length === 0) {
        // "user:" with an empty password: malformed.
        return null;
    }

    // Determine whether a trailing segment is a shared secret. We only treat the
    // trailing segment (after the LAST colon) as a shared secret when it looks
    // like one; otherwise the whole remainder is the password (so passwords may
    // contain ':').
    const lastColon = remainder.lastIndexOf(':');
    if (lastColon !== -1) {
        const candidate = remainder.slice(lastColon + 1);
        const password = remainder.slice(0, lastColon);
        if (password.length > 0 && SHARED_SECRET_RE.test(candidate)) {
            return { username, password, sharedSecret: candidate };
        }
    }

    return { username, password: remainder, sharedSecret: undefined };
}

module.exports = { parseAccountLines };

'use strict';

// CS2 XP heuristic constants. 327680000 is the intentional CS2 XP base
// (well below Number.MAX_SAFE_INTEGER); raw absolute XP values above this
// base are converted to XP-within-level. These must not be altered or rounded.
const CS2_XP_BASE = 327680000;
const CS2_XP_PER_LEVEL = 5000;

/**
 * Subtract the CS2 XP base, clamp to >= 0, then take XP-within-level.
 * This is the "always subtract" form used by the PlayersProfile path.
 * @param {number} rawXp
 * @returns {number}
 */
function xpModuloLevel(rawXp) {
    let into = rawXp - CS2_XP_BASE;
    if (into < 0) into = 0;
    return into % CS2_XP_PER_LEVEL;
}

/**
 * Convert raw absolute XP to XP-within-level when it looks like a raw value.
 * This is the guarded form used by the accountmain path: only values strictly
 * greater than the base are treated as raw absolute XP; anything else is
 * returned unchanged.
 * @param {number} rawXp
 * @returns {number}
 */
function xpIntoLevel(rawXp) {
    if (rawXp > CS2_XP_BASE) {
        return xpModuloLevel(rawXp);
    }
    return rawXp;
}

module.exports = { CS2_XP_BASE, CS2_XP_PER_LEVEL, xpModuloLevel, xpIntoLevel };

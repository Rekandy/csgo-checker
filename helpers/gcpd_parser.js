'use strict';

/**
 * GCPD HTML Parser - ported from steam-account-manager/core/steam_gcpd/gcpd_parser.cpp
 *
 * Provides robust extraction of CS2 matchmaking stats, cooldowns, and account data
 * from Steam GCPD (Game Client Personal Data) HTML pages. Uses table-based parsing
 * with dynamic column detection rather than brittle regex patterns.
 */

// Sentinel value: cooldown that never expires (e.g., permanent ban)
const COOLDOWN_NEVER = -1;

/**
 * Remove HTML tags, decode common HTML entities, and trim whitespace.
 * @param {string} str
 * @returns {string}
 */
function stripTags(str) {
  if (!str) return '';
  // Remove HTML tags
  let out = '';
  let inTag = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '<') { inTag = true; continue; }
    if (c === '>') { inTag = false; continue; }
    if (!inTag) {
      if (c === '\n' || c === '\r' || c === '\t') continue;
      out += c;
    }
  }
  // Decode common HTML entities
  out = out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return out.trim();
}

/**
 * Case-insensitive substring search.
 * @param {string} hay
 * @param {string} needle
 * @returns {boolean}
 */
function containsCI(hay, needle) {
  if (!needle) return true;
  if (!hay) return false;
  return hay.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
}

/**
 * Parse a string into an integer, ignoring commas and spaces. Returns dflt on failure.
 * @param {string} s
 * @param {number} dflt
 * @returns {number}
 */
function toInt(s, dflt) {
  if (dflt === undefined) dflt = -1;
  if (!s) return dflt;
  const cleaned = s.replace(/[, ]/g, '');
  const v = parseInt(cleaned, 10);
  return isNaN(v) ? dflt : v;
}

/**
 * Parse a GCPD timestamp string like "2024-01-15 12:30:45" into Unix seconds (UTC).
 * @param {string} s
 * @returns {number} Unix timestamp in seconds, or 0 on failure
 */
function parseGcpdTimestamp(s) {
  if (!s || !s.trim()) return 0;
  // Expected format: YYYY-MM-DD HH:MM:SS (may have trailing " GMT" or similar)
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return 0;
  const [, y, mo, d, h, mi, se] = match;
  // Parse as UTC
  const dateStr = `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
  const ts = Date.parse(dateStr);
  if (isNaN(ts)) return 0;
  return Math.floor(ts / 1000);
}

/**
 * Extract all <table> elements with class containing "generic_kv_table" and parse
 * them into arrays of rows. Each row is an array of cell text (tags stripped).
 * @param {string} html
 * @returns {Array<Array<Array<string>>>} Array of tables, each table is array of rows, each row is array of cell strings
 */
function extractTables(html) {
  if (!html) return [];
  const tables = [];
  // Match table elements whose class attribute contains "generic_kv_table"
  const tableRegex = /<table[^>]*class\s*=\s*"[^"]*generic_kv_table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const rows = [];
    // Extract rows
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cells = [];
      // Extract cells (th or td)
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(stripTags(cellMatch[1]));
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
    }
    if (rows.length > 0) {
      tables.push(rows);
    }
  }
  return tables;
}

/**
 * Check if the header row of a table contains any of the given keywords (case-insensitive).
 * @param {Array<Array<string>>} table - parsed table (array of rows)
 * @param {string[]} needles - keywords to look for
 * @returns {boolean}
 */
function headerContainsAnyCell(table, needles) {
  if (!table || table.length === 0) return false;
  const header = table[0];
  for (let i = 0; i < header.length; i++) {
    for (let j = 0; j < needles.length; j++) {
      if (containsCI(header[i], needles[j])) return true;
    }
  }
  return false;
}

/**
 * Parse matchmaking data from GCPD 590/matchmaking HTML.
 *
 * Extracts Premier rating/wins, Wingman rank/wins, and active cooldowns.
 * Uses dynamic column detection from the table header row.
 *
 * @param {string} html - Full HTML of the GCPD matchmaking page
 * @returns {{ok: boolean, premier_rating: number, premier_wins: number, wingman_rank: number, wingman_wins: number, cooldown_expires_unix: number, cooldown_reason: string}}
 */
function parseMatchmaking(html) {
  const result = {
    ok: false,
    premier_rating: 0,
    premier_wins: 0,
    wingman_rank: 0,
    wingman_wins: 0,
    cooldown_expires_unix: 0,
    cooldown_reason: ''
  };

  const tables = extractTables(html);
  if (tables.length === 0) return result;
  result.ok = true;

  const nowSeconds = Math.floor(Date.now() / 1000);

  for (let t = 0; t < tables.length; t++) {
    const tbl = tables[t];
    if (tbl.length < 2) continue;
    const header = tbl[0];
    if (header.length === 0) continue;

    // Cooldown table
    if (containsCI(header[0], 'Cooldown')) {
      for (let i = 1; i < tbl.length; i++) {
        const row = tbl[i];
        if (row.length === 0) continue;
        const ts = parseGcpdTimestamp(row[0]);
        if (ts === 0) {
          // Non-timestamp row: check for permanent cooldown indicator
          const hasLevel = row.length > 1 && toInt(row[1], 0) >= 1;
          if (row[0] && hasLevel) {
            result.cooldown_expires_unix = COOLDOWN_NEVER;
            result.cooldown_reason = 'Competitive cooldown';
          }
          continue;
        }
        // Skip if already permanently banned
        if (result.cooldown_expires_unix === COOLDOWN_NEVER) continue;
        // Only track future cooldowns, pick the earliest
        if (ts > nowSeconds &&
            (result.cooldown_expires_unix === 0 || ts < result.cooldown_expires_unix)) {
          result.cooldown_expires_unix = ts;
          result.cooldown_reason = 'Competitive cooldown';
        }
      }
      continue;
    }

    // Matchmaking Mode table
    if (containsCI(header[0], 'Matchmaking Mode')) {
      // Skip map-specific tables (localized map header keywords)
      if (headerContainsAnyCell(tbl, ['Map', 'Mappa', 'Mapa', 'Carte', 'Karte'])) {
        continue;
      }

      // Dynamically find column indices for Skill and Wins
      let skillCol = -1;
      let winsCol = -1;
      for (let c = 0; c < header.length; c++) {
        if (skillCol < 0 && containsCI(header[c], 'Skill')) skillCol = c;
        if (winsCol < 0 && containsCI(header[c], 'Wins')) winsCol = c;
      }
      // Default columns if not found in header
      if (skillCol < 0) skillCol = 4;
      if (winsCol < 0) winsCol = 1;

      for (let i = 1; i < tbl.length; i++) {
        const row = tbl[i];
        if (row.length === 0) continue;
        const skill = row.length > skillCol ? toInt(row[skillCol], -1) : -1;
        const wins = row.length > winsCol ? toInt(row[winsCol], -1) : -1;
        if (skill < 0 && wins < 0) continue;

        if (containsCI(row[0], 'Premier')) {
          if (skill > 0) result.premier_rating = skill;
          if (wins >= 0) result.premier_wins = wins;
        } else if (containsCI(row[0], 'Wingman')) {
          if (skill > 0) result.wingman_rank = skill;
          if (wins >= 0) result.wingman_wins = wins;
        }
      }
      continue;
    }
  }

  return result;
}

/**
 * Parse account main data from GCPD 590/accountmain HTML.
 *
 * Extracts CS2 player level and XP by searching for known labels in cell text.
 *
 * @param {string} html - Full HTML of the GCPD accountmain page
 * @returns {{ok: boolean, cs2_player_level: number, cs2_player_xp: number}}
 */
function parseAccountMain(html) {
  const result = {
    ok: false,
    cs2_player_level: -1,
    cs2_player_xp: -1
  };

  const tables = extractTables(html);
  if (tables.length === 0) return result;
  result.ok = true;

  // Concatenate all cell text into a single blob for label searching
  let blob = '';
  for (let t = 0; t < tables.length; t++) {
    const tbl = tables[t];
    for (let r = 0; r < tbl.length; r++) {
      const row = tbl[r];
      for (let c = 0; c < row.length; c++) {
        blob += row[c] + '\n';
      }
    }
  }

  /**
   * Find the first integer that follows any of the given labels (with colon).
   * @param {string[]} labels
   * @returns {number} The extracted integer, or -1 if not found
   */
  function extractIntAfter(labels) {
    for (let l = 0; l < labels.length; l++) {
      const needle = labels[l] + ':';
      let pos = blob.indexOf(needle);
      while (pos !== -1) {
        pos += needle.length;
        // Skip whitespace (including newlines in the blob)
        while (pos < blob.length && /\s/.test(blob[pos])) pos++;
        // Try to extract an integer
        const numMatch = blob.substring(pos).match(/^(\d+)/);
        if (numMatch) {
          return parseInt(numMatch[1], 10);
        }
        pos = blob.indexOf(needle, pos);
      }
    }
    return -1;
  }

  result.cs2_player_level = extractIntAfter([
    'CS:GO Profile Rank',
    'CS2 Profile Rank',
    'Profile Rank',
    'Player Level'
  ]);

  result.cs2_player_xp = extractIntAfter([
    'Experience points earned towards next rank',
    'Player XP',
    'XP'
  ]);

  return result;
}

/**
 * Check if the HTML looks like a valid GCPD page.
 * @param {string} html
 * @returns {boolean}
 */
function looksLikeGcpdPage(html) {
  return containsCI(html, 'generic_kv_table') ||
         containsCI(html, 'Personal Game Data');
}

/**
 * Check if the HTML looks like a Steam login/redirect page.
 * @param {string} html
 * @returns {boolean}
 */
function looksLikeLoginPage(html) {
  return containsCI(html, 'g_steamID = false') ||
         containsCI(html, '<title>Sign In');
}

module.exports = {
  parseMatchmaking,
  parseAccountMain,
  looksLikeGcpdPage,
  looksLikeLoginPage
};

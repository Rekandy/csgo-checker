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
  let tableMatch = tableRegex.exec(html);
  while (tableMatch !== null) {
    const tableHtml = tableMatch[1];
    const rows = [];
    // Extract rows
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch = rowRegex.exec(tableHtml);
    while (rowMatch !== null) {
      const rowHtml = rowMatch[1];
      const cells = [];
      // Extract cells (th or td)
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch = cellRegex.exec(rowHtml);
      while (cellMatch !== null) {
        cells.push(stripTags(cellMatch[1]));
        cellMatch = cellRegex.exec(rowHtml);
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
      rowMatch = rowRegex.exec(tableHtml);
    }
    if (rows.length > 0) {
      tables.push(rows);
    }
    tableMatch = tableRegex.exec(html);
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

// Localized keyword lists for dynamic header detection across common Steam locales.
// These are used so that reordered or translated column headers are still matched.
// English, German, Russian, French, Spanish, Italian, Portuguese (Brazil).
const KEYWORDS_SKILL = ['Skill', 'Skill Group', 'Rating', 'Fähigkeit', 'Ранг', 'Навык', 'Compétence', 'Habilidad', 'Abilità', 'Habilidade'];
const KEYWORDS_WINS = ['Wins', 'Siege', 'Победы', 'Побед', 'Victoires', 'Victorias', 'Vittorie', 'Vitórias'];
const KEYWORDS_COOLDOWN = ['Cooldown', 'Abklingzeit', 'Sperre', 'Блокировка', 'Ожидание', 'Тайм-аут', 'Pénalité', 'Sanction', 'Penalización', 'Penalità', 'Penalidade'];
const KEYWORDS_MM_MODE = ['Matchmaking Mode', 'Matchmaking-Modus', 'Режим матчмейкинга', 'Режим', 'Mode de matchmaking', 'Modo de emparejamiento', 'Modalità matchmaking', 'Modo de matchmaking'];
const KEYWORDS_MAP = ['Map', 'Mappa', 'Mapa', 'Carte', 'Karte', 'Карта'];

/**
 * Find the index of the first header cell that matches any of the given keywords.
 * @param {string[]} header - header row cells
 * @param {string[]} needles - keywords to look for
 * @returns {number} column index, or -1 if none match
 */
function findColumn(header, needles) {
  if (!header) return -1;
  for (let c = 0; c < header.length; c++) {
    for (let j = 0; j < needles.length; j++) {
      if (containsCI(header[c], needles[j])) return c;
    }
  }
  return -1;
}

/**
 * Helper to process a single row in the cooldown table.
 */
function processCooldownRow(row, result, nowSeconds) {
  if (!row || row.length === 0) return;
  const ts = parseGcpdTimestamp(row[0]);
  if (ts === 0) {
    const hasLevel = row.length > 1 && toInt(row[1], 0) >= 1;
    if (row[0] && hasLevel) {
      result.cooldown_expires_unix = COOLDOWN_NEVER;
      result.cooldown_reason = 'Competitive cooldown';
    }
    return;
  }
  if (result.cooldown_expires_unix === COOLDOWN_NEVER) return;
  if (ts > nowSeconds && (result.cooldown_expires_unix === 0 || ts < result.cooldown_expires_unix)) {
    result.cooldown_expires_unix = ts;
    result.cooldown_reason = 'Competitive cooldown';
  }
}

/**
 * Parse a cooldown table into the running matchmaking `result`.
 */
function parseCooldownTable(tbl, result, nowSeconds) {
  for (let i = 1; i < tbl.length; i++) {
    processCooldownRow(tbl[i], result, nowSeconds);
  }
}

/**
 * Helper to process a single row in the matchmaking mode table.
 */
function processModeRow(row, skillCol, winsCol, result) {
  if (!row || row.length === 0) return;
  const skill = (skillCol >= 0 && row.length > skillCol) ? toInt(row[skillCol], -1) : -1;
  const wins = (winsCol >= 0 && row.length > winsCol) ? toInt(row[winsCol], -1) : -1;
  if (skill < 0 && wins < 0) return;

  if (containsCI(row[0], 'Premier')) {
    result.premier_present = true;
    if (skill >= 0) result.premier_rating = skill;
    if (wins >= 0) result.premier_wins = wins;
  } else if (containsCI(row[0], 'Wingman')) {
    result.wingman_present = true;
    if (skill >= 0) result.wingman_rank = skill;
    if (wins >= 0) result.wingman_wins = wins;
  }
}

/**
 * Parse a matchmaking-mode table into the running matchmaking `result`.
 */
function parseMatchmakingModeTable(tbl, result) {
  const header = tbl[0];
  if (headerContainsAnyCell(tbl, KEYWORDS_MAP)) return;

  const skillCol = findColumn(header, KEYWORDS_SKILL);
  const winsCol = findColumn(header, KEYWORDS_WINS);
  if (skillCol < 0 && winsCol < 0) return;

  for (let i = 1; i < tbl.length; i++) {
    processModeRow(tbl[i], skillCol, winsCol, result);
  }
}

function processSingleTable(tbl, result, nowSeconds) {
  if (tbl.length < 2) return;
  const header = tbl[0];
  if (!header || header.length === 0) return;

  if (findColumn(header, KEYWORDS_COOLDOWN) === 0 || containsCI(header[0], 'Cooldown')) {
    parseCooldownTable(tbl, result, nowSeconds);
  } else if (findColumn(header, KEYWORDS_MM_MODE) === 0 || containsCI(header[0], 'Matchmaking Mode')) {
    parseMatchmakingModeTable(tbl, result);
  }
}

/**
 * Parse matchmaking data from GCPD 590/matchmaking HTML.
 */
function parseMatchmaking(html) {
  const result = {
    ok: false,
    premier_rating: 0,
    premier_wins: 0,
    premier_present: false,
    wingman_rank: 0,
    wingman_wins: 0,
    wingman_present: false,
    cooldown_expires_unix: 0,
    cooldown_reason: ''
  };

  let tables;
  try {
    tables = extractTables(html);
  } catch (e) {
    return result;
  }
  if (tables.length === 0) return result;
  result.ok = true;

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let t = 0; t < tables.length; t++) {
      processSingleTable(tables[t], result, nowSeconds);
    }
  } catch (e) {
    return result;
  }

  return result;
}

/**
 * Parse account main data from GCPD 590/accountmain HTML.
 *
 * Extracts CS2 player level and XP by searching for known labels in cell text.
 *
 * Unknown sentinels: cs2_player_level and cs2_player_xp stay at -1 when the
 * label cannot be found. `ok` is false when the input is null/empty/malformed
 * or contains no parseable GCPD tables. This function never throws and never
 * fabricates values.
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

  let tables;
  try {
    tables = extractTables(html);
  } catch (e) {
    return result;
  }
  if (tables.length === 0) return result;
  result.ok = true;

  try {

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

  } catch (e) {
    // Never throw: return whatever was parsed so far.
    return result;
  }

  return result;
}

/**
 * Check if the HTML looks like a valid GCPD page.
 * Null/empty-safe: returns false for missing input.
 * @param {string} html
 * @returns {boolean}
 */
function looksLikeGcpdPage(html) {
  if (!html) return false;
  return containsCI(html, 'generic_kv_table') ||
         containsCI(html, 'Personal Game Data');
}

/**
 * Check if the HTML looks like a Steam login/redirect page.
 * Null/empty-safe: returns false for missing input.
 * @param {string} html
 * @returns {boolean}
 */
function looksLikeLoginPage(html) {
  if (!html) return false;
  return containsCI(html, 'g_steamID = false') ||
         containsCI(html, '<title>Sign In') ||
         containsCI(html, 'https://steamcommunity.com/login/home') ||
         containsCI(html, 'login_area');
}

/**
 * Check if the HTML looks like a Steam error / unavailable page, such as a
 * private profile, an access-denied notice, or a generic Steam error page.
 * Callers should treat a positive result as "data unavailable" and leave
 * fields at their unknown sentinels rather than parsing the page as data.
 * Null/empty-safe: returns false for missing input.
 * @param {string} html
 * @returns {boolean}
 */
function looksLikeErrorPage(html) {
  if (!html) return false;
  return containsCI(html, 'error_ctn') ||
         containsCI(html, 'profile_private_info') ||
         containsCI(html, 'This profile is private') ||
         containsCI(html, 'This profile is unavailable') ||
         containsCI(html, 'The specified profile could not be found') ||
         containsCI(html, 'The specified profile is private') ||
         containsCI(html, 'You need a valid game license to access this page') ||
         // Steam's generic error page wraps its message in a dedicated
         // container (id="error_box"). Match that specific marker rather than
         // the bare "sectionText" class, which also appears on legitimate
         // Steam pages and would misclassify valid GCPD pages as unavailable.
         containsCI(html, 'id="error_box"') ||
         containsCI(html, 'error_box_top');
}

module.exports = {
  parseMatchmaking,
  parseAccountMain,
  looksLikeGcpdPage,
  looksLikeLoginPage,
  looksLikeErrorPage,
  COOLDOWN_NEVER
};

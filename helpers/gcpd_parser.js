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
  const v = Number.parseInt(cleaned, 10);
  return Number.isNaN(v) ? dflt : v;
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
  if (Number.isNaN(ts)) return 0;
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
 * Detect a permanent-cooldown row: a non-timestamp first cell paired with a
 * cooldown level of at least 1 (e.g. "Permanent", "7").
 * @param {string[]} row - parsed cooldown row cells
 * @returns {boolean}
 */
function isPermanentCooldownRow(row) {
  const hasLevel = row.length > 1 && toInt(row[1], 0) >= 1;
  return Boolean(row[0]) && hasLevel;
}

/**
 * Decide whether a future cooldown timestamp is the new earliest cooldown to
 * record on `result`.
 * @param {number} ts - candidate cooldown timestamp (Unix seconds)
 * @param {object} result - running matchmaking result
 * @param {number} nowSeconds - current Unix time in seconds
 * @returns {boolean}
 */
function isEarlierFutureCooldown(ts, result, nowSeconds) {
  if (ts <= nowSeconds) return false;
  return result.cooldown_expires_unix === 0 || ts < result.cooldown_expires_unix;
}

/**
 * Apply a single cooldown row to the running matchmaking `result`. Mirrors the
 * original inline behavior exactly: permanent indicators win, otherwise the
 * earliest future timestamp is tracked.
 * @param {string[]} row - parsed cooldown row cells
 * @param {object} result - matchmaking result object (mutated in place)
 * @param {number} nowSeconds - current Unix time in seconds
 */
function applyCooldownRow(row, result, nowSeconds) {
  const ts = parseGcpdTimestamp(row[0]);
  if (ts === 0) {
    // Non-timestamp row: check for permanent cooldown indicator
    if (isPermanentCooldownRow(row)) {
      result.cooldown_expires_unix = COOLDOWN_NEVER;
      result.cooldown_reason = 'Competitive cooldown';
    }
    return;
  }
  // Skip if already permanently banned
  if (result.cooldown_expires_unix === COOLDOWN_NEVER) return;
  // Only track future cooldowns, pick the earliest
  if (isEarlierFutureCooldown(ts, result, nowSeconds)) {
    result.cooldown_expires_unix = ts;
    result.cooldown_reason = 'Competitive cooldown';
  }
}

/**
 * Parse a cooldown table into the running matchmaking `result`. Tracks the
 * earliest future cooldown and a permanent (COOLDOWN_NEVER) cooldown, matching
 * the original inline behavior exactly.
 * @param {Array<Array<string>>} tbl - parsed cooldown table (rows of cells)
 * @param {object} result - matchmaking result object (mutated in place)
 * @param {number} nowSeconds - current Unix time in seconds
 */
function parseCooldownTable(tbl, result, nowSeconds) {
  for (let i = 1; i < tbl.length; i++) {
    const row = tbl[i];
    if (row.length === 0) continue;
    applyCooldownRow(row, result, nowSeconds);
  }
}

/**
 * Parse a cooldown table into the running matchmaking `result`.
 */
/**
 * Extract an integer value from a row at the given column, returning -1 when
 * the column is absent (col < 0) or the row is too short. Matches the original
 * inline guard exactly.
 * @param {string[]} row - parsed row cells
 * @param {number} col - column index (or < 0 when the column was not found)
 * @returns {number} parsed value, or -1 when unavailable
 */
function cellIntAt(row, col) {
  return (col >= 0 && row.length > col) ? toInt(row[col], -1) : -1;
}

/**
 * Apply a parsed matchmaking-mode row to the running `result`. The row is
 * matched to Premier or Wingman by its first cell; skill/wins are written only
 * when their column was present (value >= 0), which preserves the expired /
 * unranked (value 0) case exactly.
 * @param {string[]} row - parsed matchmaking-mode row cells
 * @param {number} skill - parsed skill/rating value, or -1 when unavailable
 * @param {number} wins - parsed wins value, or -1 when unavailable
 * @param {object} result - matchmaking result object (mutated in place)
 */
function applyMatchmakingModeRow(row, skill, wins, result) {
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

function parseMatchmakingModeTable(tbl, result) {
  const header = tbl[0];
  if (headerContainsAnyCell(tbl, KEYWORDS_MAP)) return;

  const skillCol = findColumn(header, KEYWORDS_SKILL);
  const winsCol = findColumn(header, KEYWORDS_WINS);
  if (skillCol < 0 && winsCol < 0) return;

  for (let i = 1; i < tbl.length; i++) {
    const row = tbl[i];
    if (row.length === 0) continue;
    const skill = cellIntAt(row, skillCol);
    const wins = cellIntAt(row, winsCol);
    if (skill < 0 && wins < 0) continue;

    // The row exists for this mode: mark it present so the caller can tell
    // "expired/unranked (rating 0)" apart from "no data". Record a parsed
    // rating/rank of 0 too (skill === 0), which is exactly the expired /
    // unranked case - only skip writing when the skill column was absent
    // (skill < 0). Wins are written whenever the column was present
    // (wins >= 0), including 0.
    applyMatchmakingModeRow(row, skill, wins, result);
  }
}

/**
 * Dispatch a single parsed GCPD table to the appropriate parser based on its
 * header row. Extracted so the parseMatchmaking loop body stays flat and
 * within complexity limits. Cooldown and matchmaking-mode tables are the only
 * recognized shapes; anything else is ignored.
 * @param {Array<Array<string>>} tbl - parsed table (rows of cells)
 * @param {object} result - matchmaking result object (mutated in place)
 * @param {number} nowSeconds - current Unix time in seconds
 */
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
    // Resilient parsing: malformed/unexpected HTML must never throw. Return the
    // zero-initialized result so the caller treats this page as "nothing found"
    // rather than crashing the check.
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
    // A single unparseable table must not discard everything already parsed;
    // return the partially-populated result instead of throwing.
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
    // Resilient parsing: malformed/unexpected HTML must never throw. Return the
    // zero-initialized result so the caller treats this page as "nothing found"
    // rather than crashing the check.
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
          return Number.parseInt(numMatch[1], 10);
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

/**
 * Extract per-map "Ranked Competitive" stats from a GCPD matchmaking page.
 *
 * The main parser does not cover per-map data, so this uses the same regex
 * shape the main process previously ran inline. Returns a map keyed by the
 * (trimmed) map name; an empty object when no rows are present. Behavior is
 * byte-identical to the original inline extraction.
 * @param {string} html - Raw GCPD matchmaking HTML
 * @returns {Object<string, {wins:number, ties:number, losses:number, skill_group:(string|null), last_match:string, region:number}>}
 */
// Shared body of the competitive-map row regex. The /g scan wraps it in
// <tr>...</tr> to slice whole rows out of the page; the per-row exec matches
// the same capture groups inside a single sliced row. Keeping one source here
// guarantees the two stay byte-identical.
//
// NOTE (SonarQube regex-complexity): the seven `[\s\S]*?` gap separators are
// irreducible - each skips the intervening cells between the seven <td> values
// we actually capture (map name, wins, ties, losses, skill group, last-match
// timestamp, region), in order, within one table row. Collapsing or reusing a
// separator would change which cells are matched and break byte-identical
// extraction (see test/gcpd_parser.js extractCompetitiveMaps cases), so the
// complexity is accepted rather than "simplified" into a behavior change.
const COMPETITIVE_MAP_ROW_SOURCE = '<td>Ranked Competitive<\\/td>[\\s\\S]*?<td>([^<]+)<\\/td>[\\s\\S]*?<td>(\\d+)<\\/td>[\\s\\S]*?<td>(\\d+)<\\/td>[\\s\\S]*?<td>(\\d+)<\\/td>[\\s\\S]*?<td>([^<]*)<\\/td>[\\s\\S]*?<td>(\\d\\d\\d\\d-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d GMT)<\\/td>[\\s\\S]*?<td>(\\d+)<\\/td>';

/**
 * Parse a single sliced competitive-map row into its structured record.
 * Returns null when the row does not match. Field extraction (trims, parseInt
 * radix 10, null skill_group) is byte-identical to the original inline code.
 * @param {string} row - one <tr>...</tr> slice
 * @returns {?{name:string, wins:number, ties:number, losses:number, skill_group:(string|null), last_match:string, region:number}}
 */
function parseCompetitiveMapRow(row) {
  const m = new RegExp(COMPETITIVE_MAP_ROW_SOURCE).exec(row);
  if (!m) return null;
  return {
    name: m[1].trim(),
    wins: Number.parseInt(m[2], 10),
    ties: Number.parseInt(m[3], 10),
    losses: Number.parseInt(m[4], 10),
    skill_group: m[5].trim() || null,
    last_match: m[6],
    region: Number.parseInt(m[7], 10)
  };
}

function extractCompetitiveMaps(html) {
  const mapsData = {};
  if (!html) return mapsData;
  const mapRows = html.match(new RegExp('<tr>[\\s\\S]*?' + COMPETITIVE_MAP_ROW_SOURCE + '[\\s\\S]*?<\\/tr>', 'g'));
  if (mapRows) {
    mapRows.forEach(function(row) {
      const parsed = parseCompetitiveMapRow(row);
      if (parsed) {
        const { name, ...record } = parsed;
        mapsData[name] = record;
      }
    });
  }
  return mapsData;
}

module.exports = {
  parseMatchmaking,
  parseAccountMain,
  looksLikeGcpdPage,
  looksLikeLoginPage,
  looksLikeErrorPage,
  extractCompetitiveMaps,
  COOLDOWN_NEVER
};

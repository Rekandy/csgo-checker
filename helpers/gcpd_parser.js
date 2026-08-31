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
  // Idiomatic global-regex iteration: exec() advances lastIndex on each call and
  // returns null when exhausted. The assignment in the condition is intentional.
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const rows = [];
    // Extract rows
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    // Idiomatic global-regex iteration: exec() advances lastIndex on each call and
    // returns null when exhausted. The assignment in the condition is intentional.
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cells = [];
      // Extract cells (th or td)
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch;
      // Idiomatic global-regex iteration: exec() advances lastIndex on each call and
      // returns null when exhausted. The assignment in the condition is intentional.
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
}

/**
 * Parse a matchmaking-mode table into the running matchmaking `result`. Uses
 * dynamic Skill/Wins column detection and records Premier/Wingman presence and
 * values, matching the original inline behavior exactly. Map-specific tables
 * and tables whose Skill/Wins columns cannot be identified are skipped.
 * @param {Array<Array<string>>} tbl - parsed matchmaking-mode table
 * @param {object} result - matchmaking result object (mutated in place)
 */
function parseMatchmakingModeTable(tbl, result) {
  const header = tbl[0];
  // Skip map-specific tables (localized map header keywords)
  if (headerContainsAnyCell(tbl, KEYWORDS_MAP)) {
    return;
  }

  // Dynamically find column indices for Skill and Wins from the header row.
  const skillCol = findColumn(header, KEYWORDS_SKILL);
  const winsCol = findColumn(header, KEYWORDS_WINS);
  // If neither column can be identified from the header, skip this table
  // rather than guessing wrong columns (guessing wrong is worse than
  // returning unknown).
  if (skillCol < 0 && winsCol < 0) {
    return;
  }

  for (let i = 1; i < tbl.length; i++) {
    const row = tbl[i];
    if (row.length === 0) continue;
    const skill = (skillCol >= 0 && row.length > skillCol) ? toInt(row[skillCol], -1) : -1;
    const wins = (winsCol >= 0 && row.length > winsCol) ? toInt(row[winsCol], -1) : -1;
    if (skill < 0 && wins < 0) continue;

    // The row exists for this mode: mark it present so the caller can tell
    // "expired/unranked (rating 0)" apart from "no data". Record a parsed
    // rating/rank of 0 too (skill === 0), which is exactly the expired /
    // unranked case - only skip writing when the skill column was absent
    // (skill < 0). Wins are written whenever the column was present
    // (wins >= 0), including 0.
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
}

/**
 * Parse matchmaking data from GCPD 590/matchmaking HTML.
 *
 * Extracts Premier rating/wins, Wingman rank/wins, and active cooldowns.
 * Uses dynamic column detection from the table header row.
 *
 * Unknown sentinels: numeric fields stay at 0 when the value cannot be
 * determined; cooldown_expires_unix is 0 when there is no cooldown and
 * COOLDOWN_NEVER (-1) for a permanent cooldown. `ok` is false when the input
 * is null/empty/malformed or contains no parseable GCPD tables. This function
 * never throws and never fabricates values.
 *
 * @param {string} html - Full HTML of the GCPD matchmaking page
 * The *_present flags indicate whether a row for that mode actually existed in
 * the matchmaking table. They let the caller distinguish "no data at all"
 * (present === false, leave the cache untouched) from "the mode is expired /
 * unranked" (present === true with rating/rank 0). An EXPIRED mode is a present
 * row whose rating/rank is 0 while wins indicate prior play - the caller maps
 * that to the frontend's expired sentinels (premier -> -1, wingman -> rank 0
 * with wins retained).
 *
 * @param {string} html - Full HTML of the GCPD matchmaking page
 * @returns {{ok: boolean, premier_rating: number, premier_wins: number, premier_present: boolean, wingman_rank: number, wingman_wins: number, wingman_present: boolean, cooldown_expires_unix: number, cooldown_reason: string}}
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
    const tbl = tables[t];
    if (tbl.length < 2) continue;
    const header = tbl[0];
    if (header.length === 0) continue;

    // Cooldown table
    if (findColumn(header, KEYWORDS_COOLDOWN) === 0 || containsCI(header[0], 'Cooldown')) {
      parseCooldownTable(tbl, result, nowSeconds);
      continue;
    }

    // Matchmaking Mode table
    if (findColumn(header, KEYWORDS_MM_MODE) === 0 || containsCI(header[0], 'Matchmaking Mode')) {
      parseMatchmakingModeTable(tbl, result);
      continue;
    }
  }

  } catch (e) {
    // Never throw: return whatever was parsed so far (ok stays true because
    // tables were present), leaving unknown fields at their sentinels.
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
function extractCompetitiveMaps(html) {
  const mapsData = {};
  if (!html) return mapsData;
  const mapRows = html.match(/<tr>[\s\S]*?<td>Ranked Competitive<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([^<]*)<\/td>[\s\S]*?<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<\/tr>/g);
  if (mapRows) {
    mapRows.forEach(function(row) {
      const mapMatch = /<td>Ranked Competitive<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([^<]*)<\/td>[\s\S]*?<td>(\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d GMT)<\/td>[\s\S]*?<td>(\d+)<\/td>/.exec(row);
      if (mapMatch) {
        mapsData[mapMatch[1].trim()] = {
          wins: parseInt(mapMatch[2], 10),
          ties: parseInt(mapMatch[3], 10),
          losses: parseInt(mapMatch[4], 10),
          skill_group: mapMatch[5].trim() || null,
          last_match: mapMatch[6],
          region: parseInt(mapMatch[7], 10)
        };
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

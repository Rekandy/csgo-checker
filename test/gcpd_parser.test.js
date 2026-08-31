'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    parseMatchmaking,
    parseAccountMain,
    looksLikeGcpdPage,
    looksLikeLoginPage,
    looksLikeErrorPage,
    COOLDOWN_NEVER
} = require('../helpers/gcpd_parser.js');

// --- Fixture builders -------------------------------------------------------

/**
 * Build a generic_kv_table from an array of rows (each row an array of cells).
 * @param {Array<Array<string>>} rows
 * @returns {string}
 */
function buildTable(rows) {
    const body = rows.map(cells => {
        const tds = cells.map(c => `<td>${c}</td>`).join('');
        return `<tr>${tds}</tr>`;
    }).join('');
    return `<table class="generic_kv_table">${body}</table>`;
}

function wrap(inner) {
    return `<html><body>${inner}</body></html>`;
}

// A future timestamp (well beyond now) formatted as GCPD does.
function futureTimestamp() {
    const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}

// --- (a) normal matchmaking page -------------------------------------------

test('(a) normal matchmaking page parses Premier + Wingman rating/wins', () => {
    const mm = buildTable([
        ['Matchmaking Mode', 'Wins', 'Ties', 'Losses', 'Skill Group', 'Last Match'],
        ['Premier', '1234', '0', '0', '18500', '2024-01-01 00:00:00 GMT'],
        ['Wingman', '42', '0', '0', '11', '2024-01-01 00:00:00 GMT']
    ]);
    const res = parseMatchmaking(wrap(mm));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.premier_rating, 18500);
    assert.strictEqual(res.premier_wins, 1234);
    assert.strictEqual(res.wingman_rank, 11);
    assert.strictEqual(res.wingman_wins, 42);
});

// --- (b) localized headers --------------------------------------------------

test('(b) localized German/Russian headers still parse', () => {
    const mmDe = buildTable([
        ['Matchmaking-Modus', 'Siege', 'Fähigkeit'],
        ['Premier', '500', '15000']
    ]);
    const resDe = parseMatchmaking(wrap(mmDe));
    assert.strictEqual(resDe.premier_rating, 15000);
    assert.strictEqual(resDe.premier_wins, 500);

    const mmRu = buildTable([
        ['Режим матчмейкинга', 'Победы', 'Навык'],
        ['Premier', '77', '9000']
    ]);
    const resRu = parseMatchmaking(wrap(mmRu));
    assert.strictEqual(resRu.premier_rating, 9000);
    assert.strictEqual(resRu.premier_wins, 77);
});

// --- (c) missing matchmaking table -----------------------------------------

test('(c) missing matchmaking table -> no throw, zeros', () => {
    const res = parseMatchmaking(wrap('<div>no tables here</div>'));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.premier_rating, 0);
    assert.strictEqual(res.premier_wins, 0);
});

// --- (d) reordered columns --------------------------------------------------

test('(d) reordered columns still correct via header detection', () => {
    const mm = buildTable([
        ['Matchmaking Mode', 'Skill Group', 'Last Match', 'Wins'],
        ['Premier', '20000', '2024-01-01 00:00:00 GMT', '999']
    ]);
    const res = parseMatchmaking(wrap(mm));
    assert.strictEqual(res.premier_rating, 20000);
    assert.strictEqual(res.premier_wins, 999);
});

// --- (e) active cooldown ----------------------------------------------------

test('(e) active cooldown row with future timestamp sets cooldown_expires_unix', () => {
    const ts = futureTimestamp();
    const cd = buildTable([
        ['Cooldown Expiration', 'Cooldown Level'],
        [ts, '1']
    ]);
    const res = parseMatchmaking(wrap(cd));
    assert.ok(res.cooldown_expires_unix > Math.floor(Date.now() / 1000));
    assert.strictEqual(res.cooldown_reason, 'Competitive cooldown');
});

// --- (f) permanent cooldown -------------------------------------------------

test('(f) permanent cooldown -> COOLDOWN_NEVER (-1)', () => {
    const cd = buildTable([
        ['Cooldown Expiration', 'Cooldown Level'],
        ['Permanent', '7']
    ]);
    const res = parseMatchmaking(wrap(cd));
    assert.strictEqual(res.cooldown_expires_unix, COOLDOWN_NEVER);
});

// --- (g) login page ---------------------------------------------------------

test('(g) login page -> looksLikeLoginPage true, no fake data', () => {
    const html = '<html><head><title>Sign In</title></head><body>g_steamID = false;</body></html>';
    assert.strictEqual(looksLikeLoginPage(html), true);
    const res = parseMatchmaking(html);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.premier_rating, 0);
});

test('(g2) error/private profile page -> looksLikeErrorPage true', () => {
    const priv = '<html><body><div class="error_ctn">This profile is private</div></body></html>';
    assert.strictEqual(looksLikeErrorPage(priv), true);
    assert.strictEqual(looksLikeGcpdPage(priv), false);
});

test('(g3) Steam generic error page (error_box) -> looksLikeErrorPage true', () => {
    const err = '<html><body><div id="error_box"><div class="error_box_top"></div>' +
        '<div class="sectionText">There was an error.</div></div></body></html>';
    assert.strictEqual(looksLikeErrorPage(err), true);
});

test('(g4) valid GCPD page containing "sectionText" is NOT misclassified as error', () => {
    // Regression: the old marker matched the bare "sectionText" substring,
    // which also appears on legitimate Steam pages, so a valid GCPD page was
    // wrongly treated as unavailable and its data silently dropped.
    const mm = buildTable([
        ['Matchmaking Mode', 'Wins', 'Skill Group'],
        ['Premier', '321', '17000']
    ]);
    const html = wrap('<div class="sectionText">Personal Game Data</div>' + mm);
    assert.strictEqual(looksLikeErrorPage(html), false);
    assert.strictEqual(looksLikeGcpdPage(html), true);
    const res = parseMatchmaking(html);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.premier_rating, 17000);
    assert.strictEqual(res.premier_wins, 321);
});

// --- (h) malformed/truncated HTML -------------------------------------------

test('(h) malformed/truncated HTML -> no throw', () => {
    const truncated = '<table class="generic_kv_table"><tr><td>Matchmaking Mode</td><td>Wins';
    assert.doesNotThrow(() => parseMatchmaking(truncated));
    assert.doesNotThrow(() => parseAccountMain(truncated));
    const broken = '<<<table class="generic_kv_table"<tr<td>>>Premier<<';
    assert.doesNotThrow(() => parseMatchmaking(broken));
});

// --- (i) empty string and null ----------------------------------------------

test('(i) empty string and null -> no throw, ok:false', () => {
    for (const input of ['', null, undefined]) {
        const mm = parseMatchmaking(input);
        assert.strictEqual(mm.ok, false);
        const am = parseAccountMain(input);
        assert.strictEqual(am.ok, false);
        assert.strictEqual(looksLikeLoginPage(input), false);
        assert.strictEqual(looksLikeErrorPage(input), false);
        assert.strictEqual(looksLikeGcpdPage(input), false);
    }
});

// --- (j) accountmain page ---------------------------------------------------

test('(j) accountmain page -> correct level/XP', () => {
    const am = buildTable([
        ['CS2 Profile Rank:', '25'],
        ['Experience points earned towards next rank:', '3200']
    ]);
    const res = parseAccountMain(wrap(am));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.cs2_player_level, 25);
    assert.strictEqual(res.cs2_player_xp, 3200);
});

// --- (k) accountmain missing labels -----------------------------------------

test('(k) accountmain missing labels -> level/xp stay -1', () => {
    const am = buildTable([
        ['Something Else:', '5'],
        ['Another Field:', '10']
    ]);
    const res = parseAccountMain(wrap(am));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.cs2_player_level, -1);
    assert.strictEqual(res.cs2_player_xp, -1);
});

// --- extra: ambiguous header -> skip rather than guess ----------------------

test('ambiguous matchmaking header (no Skill/Wins) -> skipped, no fabricated data', () => {
    const mm = buildTable([
        ['Matchmaking Mode', 'Foo', 'Bar', 'Baz'],
        ['Premier', '111', '222', '333']
    ]);
    const res = parseMatchmaking(wrap(mm));
    assert.strictEqual(res.premier_rating, 0);
    assert.strictEqual(res.premier_wins, 0);
});

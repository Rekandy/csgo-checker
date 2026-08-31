'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { applyGcRanking, mergeGcpdMatchmaking } = require('../helpers/rankMerge.js');

// --- Fixture builders -------------------------------------------------------

/**
 * A fresh account data object with all rank/wins fields at null, matching the
 * shape check_account() initializes in main.js before the GC/GCPD sources run.
 * @returns {object}
 */
function freshData() {
    return {
        rank: null, wins: null,
        rank_wg: null, wins_wg: null,
        rank_dz: null, wins_dz: null,
        rank_premier: null, wins_premier: null
    };
}

/**
 * A PlayerRankingInfo-like entry.
 * @param {number} typeId - rank_type_id (6 comp, 7 wingman, 10 dz, 11 premier)
 * @param {number} rankId - rank_id (rating for premier)
 * @param {number} wins
 * @returns {object}
 */
function ranking(typeId, rankId, wins) {
    return { rank_type_id: typeId, rank_id: rankId, wins: wins };
}

/**
 * A parseMatchmaking()-like result object.
 * @param {object} overrides
 * @returns {object}
 */
function mmResult(overrides) {
    return Object.assign({
        ok: true,
        premier_rating: 0,
        premier_wins: 0,
        premier_present: false,
        wingman_rank: 0,
        wingman_wins: 0,
        wingman_present: false,
        cooldown_expires_unix: 0,
        cooldown_reason: ''
    }, overrides);
}

// ============================================================================
// applyGcRanking
// ============================================================================

test('applyGcRanking: active competitive rank is written', () => {
    const data = freshData();
    applyGcRanking(data, ranking(6, 12, 250));
    assert.strictEqual(data.rank, 12);
    assert.strictEqual(data.wins, 250);
});

test('applyGcRanking: expired competitive (rank_id 0 + wins) is preserved, not dropped', () => {
    const data = freshData();
    applyGcRanking(data, ranking(6, 0, 42));
    // Renderer treats rank == 0 && wins >= 10 as expired: the wins must survive.
    assert.strictEqual(data.rank, 0);
    assert.strictEqual(data.wins, 42);
});

test('applyGcRanking: unranked (rank 0, wins < 10) stays unranked, not expired', () => {
    const data = freshData();
    applyGcRanking(data, ranking(6, 0, 3));
    assert.strictEqual(data.rank, 0);
    assert.strictEqual(data.wins, 3);
    // The renderer's own >= 10 gate keeps this "unranked"; the merge layer just
    // preserves the real values and does not compute expired for competitive.
});

test('applyGcRanking: rank_id/wins undefined normalize to 0', () => {
    const data = freshData();
    applyGcRanking(data, { rank_type_id: 6 });
    assert.strictEqual(data.rank, 0);
    assert.strictEqual(data.wins, 0);
});

test('applyGcRanking: competitive VAC (-1) cascades into wingman/dz/premier when comp arrives first', () => {
    const data = freshData();
    // 9110 established competitive VAC.
    data.rank = -1; data.wins = -1;
    applyGcRanking(data, ranking(7, 5, 20));
    applyGcRanking(data, ranking(10, 2, 8));
    applyGcRanking(data, ranking(11, 15000, 30));
    assert.strictEqual(data.rank_wg, -1);
    assert.strictEqual(data.wins_wg, -1);
    assert.strictEqual(data.rank_dz, -1);
    assert.strictEqual(data.wins_dz, -1);
    assert.strictEqual(data.rank_premier, -1);
    assert.strictEqual(data.wins_premier, -1);
});

test('applyGcRanking: competitive VAC cascades retroactively when comp arrives last', () => {
    const data = freshData();
    // Secondary modes resolved first, competitive VAC entry arrives after.
    applyGcRanking(data, ranking(7, 5, 20));
    applyGcRanking(data, ranking(10, 2, 8));
    applyGcRanking(data, ranking(11, 15000, 30));
    // Now competitive comes in as VAC (rank -1 established by 9110 semantics).
    data.rank = -1; data.wins = -1;
    applyGcRanking(data, ranking(6, -1, -1));
    assert.strictEqual(data.rank_wg, -1);
    assert.strictEqual(data.wins_wg, -1);
    assert.strictEqual(data.rank_dz, -1);
    assert.strictEqual(data.wins_dz, -1);
    assert.strictEqual(data.rank_premier, -1);
    assert.strictEqual(data.wins_premier, -1);
});

test('applyGcRanking: VAC does not cascade to modes CS2 never reported (still null)', () => {
    const data = freshData();
    data.rank = -1; data.wins = -1;
    applyGcRanking(data, ranking(6, -1, -1));
    // No wg/dz/premier entries => those remain untouched (null), not fabricated.
    assert.strictEqual(data.rank_wg, null);
    assert.strictEqual(data.rank_dz, null);
    assert.strictEqual(data.rank_premier, null);
});

test('applyGcRanking: VAC sentinel not overwritten by a later non-VAC entry', () => {
    const data = freshData();
    data.rank = -1; data.wins = -1;
    data.rank_wg = -1; data.wins_wg = -1;
    // A stray later wingman entry must not resurrect the banned mode.
    applyGcRanking(data, ranking(7, 8, 100));
    assert.strictEqual(data.rank_wg, -1);
    assert.strictEqual(data.wins_wg, -1);
});

test('applyGcRanking: expired 0 is NOT treated as VAC (no false cascade)', () => {
    const data = freshData();
    // Legitimate expired competitive: rank 0, wins >= 10 (NOT -1/-1).
    applyGcRanking(data, ranking(6, 0, 40));
    applyGcRanking(data, ranking(7, 0, 25));
    // Secondary mode must keep its own values, not be flipped to -1.
    assert.strictEqual(data.rank, 0);
    assert.strictEqual(data.rank_wg, 0);
    assert.strictEqual(data.wins_wg, 25);
});

// ============================================================================
// mergeGcpdMatchmaking
// ============================================================================

test('mergeGcpdMatchmaking: bails out on missing/!ok input', () => {
    const data = freshData();
    assert.strictEqual(mergeGcpdMatchmaking(data, null), data);
    assert.strictEqual(mergeGcpdMatchmaking(data, mmResult({ ok: false })), data);
    assert.strictEqual(mergeGcpdMatchmaking(null, mmResult({})), null);
    // Nothing written.
    assert.strictEqual(data.rank_premier, null);
    assert.strictEqual(data.rank_wg, null);
});

test('mergeGcpdMatchmaking: premier expired maps to -1 only at wins >= 10', () => {
    const data = freshData();
    data.rank_premier = 0; // GC set never-ranked/unranked
    mergeGcpdMatchmaking(data, mmResult({
        premier_present: true, premier_rating: 0, premier_wins: 15
    }));
    assert.strictEqual(data.rank_premier, -1);
    assert.strictEqual(data.wins_premier, 15);
});

test('mergeGcpdMatchmaking: premier with 1-9 wins is NOT expired (stays unranked 0)', () => {
    const data = freshData();
    data.rank_premier = 0;
    mergeGcpdMatchmaking(data, mmResult({
        premier_present: true, premier_rating: 0, premier_wins: 4
    }));
    // Must match wingman behavior: 4 wins + rating 0 => unranked, not expired.
    assert.strictEqual(data.rank_premier, 0);
    assert.strictEqual(data.wins_premier, 4);
});

test('mergeGcpdMatchmaking: never-ranked premier (GC-set 0) not flipped to expired by low-wins GCPD row', () => {
    const data = freshData();
    data.rank_premier = 0; data.wins_premier = 0;
    mergeGcpdMatchmaking(data, mmResult({
        premier_present: true, premier_rating: 0, premier_wins: 2
    }));
    assert.strictEqual(data.rank_premier, 0); // still never-ranked, not -1
});

test('mergeGcpdMatchmaking: active premier rating is never downgraded by GCPD', () => {
    const data = freshData();
    data.rank_premier = 18000; data.wins_premier = 50; // GC-resolved active
    mergeGcpdMatchmaking(data, mmResult({
        premier_present: true, premier_rating: 0, premier_wins: 50
    }));
    assert.strictEqual(data.rank_premier, 18000);
});

test('mergeGcpdMatchmaking: GCPD fills premier rating when GC left it unresolved', () => {
    const data = freshData();
    mergeGcpdMatchmaking(data, mmResult({
        premier_present: true, premier_rating: 21000, premier_wins: 60
    }));
    assert.strictEqual(data.rank_premier, 21000);
    assert.strictEqual(data.wins_premier, 60);
});

test('mergeGcpdMatchmaking: VAC premier (-1) never clobbered by GCPD active row', () => {
    const data = freshData();
    data.rank_premier = -1; data.wins_premier = -1;
    mergeGcpdMatchmaking(data, mmResult({
        premier_present: true, premier_rating: 20000, premier_wins: 40
    }));
    assert.strictEqual(data.rank_premier, -1);
    assert.strictEqual(data.wins_premier, -1);
});

test('mergeGcpdMatchmaking: wingman expired maps to rank 0 with wins retained', () => {
    const data = freshData();
    mergeGcpdMatchmaking(data, mmResult({
        wingman_present: true, wingman_rank: 0, wingman_wins: 22
    }));
    assert.strictEqual(data.rank_wg, 0);
    assert.strictEqual(data.wins_wg, 22); // renderer sees rank==0 && wins>=10 => expired
});

test('mergeGcpdMatchmaking: active wingman rank written from GCPD', () => {
    const data = freshData();
    mergeGcpdMatchmaking(data, mmResult({
        wingman_present: true, wingman_rank: 9, wingman_wins: 30
    }));
    assert.strictEqual(data.rank_wg, 9);
    assert.strictEqual(data.wins_wg, 30);
});

test('mergeGcpdMatchmaking: VAC wingman (-1) never clobbered by GCPD', () => {
    const data = freshData();
    data.rank_wg = -1; data.wins_wg = -1;
    mergeGcpdMatchmaking(data, mmResult({
        wingman_present: true, wingman_rank: 7, wingman_wins: 30
    }));
    assert.strictEqual(data.rank_wg, -1);
    assert.strictEqual(data.wins_wg, -1);
});

test('mergeGcpdMatchmaking: *_present === false leaves fields untouched', () => {
    const data = freshData();
    data.rank_premier = 12000; data.wins_premier = 20;
    data.rank_wg = 3; data.wins_wg = 15;
    mergeGcpdMatchmaking(data, mmResult({
        premier_present: false, premier_rating: 0, premier_wins: 99,
        wingman_present: false, wingman_rank: 0, wingman_wins: 99
    }));
    assert.strictEqual(data.rank_premier, 12000);
    assert.strictEqual(data.wins_premier, 20);
    assert.strictEqual(data.rank_wg, 3);
    assert.strictEqual(data.wins_wg, 15);
});

test('mergeGcpdMatchmaking: active GC wingman rank not downgraded by expired GCPD row', () => {
    const data = freshData();
    data.rank_wg = 6; data.wins_wg = 40; // GC-resolved active
    mergeGcpdMatchmaking(data, mmResult({
        wingman_present: true, wingman_rank: 0, wingman_wins: 40
    }));
    assert.strictEqual(data.rank_wg, 6); // stays active, not reset to 0
});

// ============================================================================
// Order-independence: the three sources converge regardless of arrival order
// ============================================================================

/**
 * Apply the given source callbacks to a fresh data object in the specified
 * order and return the resulting data. Each source is a fn(data).
 * @param {Array<function(object):void>} sources
 * @returns {object}
 */
function runInOrder(sources) {
    const data = freshData();
    for (const src of sources) src(data);
    return data;
}

/**
 * All permutations of a 3-element array.
 * @param {Array} arr
 * @returns {Array<Array>}
 */
function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permutations(rest)) out.push([arr[i]].concat(p));
    }
    return out;
}

test('order-independence: ACTIVE account converges across all source orderings', () => {
    // GC competitive/wingman/dz entries and premier from GCPD.
    const gcComp = d => applyGcRanking(d, ranking(6, 15, 300));
    const gcWg = d => applyGcRanking(d, ranking(7, 9, 80));
    const gcpd = d => mergeGcpdMatchmaking(d, mmResult({
        premier_present: true, premier_rating: 22000, premier_wins: 120,
        wingman_present: true, wingman_rank: 9, wingman_wins: 80
    }));
    const results = permutations([gcComp, gcWg, gcpd]).map(runInOrder);
    for (const r of results) {
        assert.strictEqual(r.rank, 15);
        assert.strictEqual(r.wins, 300);
        assert.strictEqual(r.rank_wg, 9);
        assert.strictEqual(r.rank_premier, 22000);
    }
});

test('order-independence: EXPIRED account converges across all source orderings', () => {
    const gcComp = d => applyGcRanking(d, ranking(6, 0, 40)); // expired comp
    const gcWg = d => applyGcRanking(d, ranking(7, 0, 25));   // expired wingman
    const gcpd = d => mergeGcpdMatchmaking(d, mmResult({
        premier_present: true, premier_rating: 0, premier_wins: 30, // expired premier
        wingman_present: true, wingman_rank: 0, wingman_wins: 25
    }));
    const results = permutations([gcComp, gcWg, gcpd]).map(runInOrder);
    for (const r of results) {
        assert.strictEqual(r.rank, 0);
        assert.strictEqual(r.wins, 40);
        assert.strictEqual(r.rank_wg, 0);
        assert.strictEqual(r.wins_wg, 25);
        assert.strictEqual(r.rank_premier, -1); // premier expired sentinel
    }
});

test('order-independence: UNRANKED account converges across all source orderings', () => {
    const gcComp = d => applyGcRanking(d, ranking(6, 0, 2));  // unranked comp
    const gcWg = d => applyGcRanking(d, ranking(7, 0, 1));    // unranked wingman
    const gcpd = d => mergeGcpdMatchmaking(d, mmResult({
        premier_present: true, premier_rating: 0, premier_wins: 3, // < 10 => unranked
        wingman_present: true, wingman_rank: 0, wingman_wins: 1
    }));
    const results = permutations([gcComp, gcWg, gcpd]).map(runInOrder);
    for (const r of results) {
        assert.strictEqual(r.rank, 0);
        assert.strictEqual(r.rank_wg, 0);
        // Premier is never flipped to the expired sentinel (-1) here: a < 10-win
        // GCPD row is unranked. With no GC premier entry the merge leaves it at
        // its incoming null, which check_account() normalizes to 0 downstream;
        // the invariant that matters is simply "not expired".
        assert.notStrictEqual(r.rank_premier, -1);
    }
});

test('order-independence: UNRANKED account with GC-set premier 0 stays 0 (not expired) in all orders', () => {
    // Include a GC premier entry of rank 0 so the never-ranked state is explicit
    // rather than relying on downstream null-normalization.
    const gcComp = d => applyGcRanking(d, ranking(6, 0, 2));
    const gcPremier = d => applyGcRanking(d, ranking(11, 0, 0));
    const gcpd = d => mergeGcpdMatchmaking(d, mmResult({
        premier_present: true, premier_rating: 0, premier_wins: 3 // < 10 => unranked
    }));
    const results = permutations([gcComp, gcPremier, gcpd]).map(runInOrder);
    for (const r of results) {
        assert.strictEqual(r.rank_premier, 0); // never flipped to expired -1
    }
});

test('order-independence: VAC account converges across all source orderings', () => {
    // Competitive VAC (rank/wins -1 from 9110) plus GC secondary entries and a
    // GCPD row that must never resurrect the banned modes.
    const gcVac = d => { d.rank = -1; d.wins = -1; applyGcRanking(d, ranking(6, -1, -1)); };
    const gcWg = d => applyGcRanking(d, ranking(7, 5, 20));
    const gcPremier = d => applyGcRanking(d, ranking(11, 18000, 40));
    const gcpd = d => mergeGcpdMatchmaking(d, mmResult({
        premier_present: true, premier_rating: 20000, premier_wins: 40,
        wingman_present: true, wingman_rank: 7, wingman_wins: 20
    }));
    const results = permutations([gcVac, gcWg, gcPremier])
        .map(perm => runInOrder(perm.concat([gcpd])));
    for (const r of results) {
        assert.strictEqual(r.rank, -1);
        assert.strictEqual(r.wins, -1);
        assert.strictEqual(r.rank_wg, -1);
        assert.strictEqual(r.wins_wg, -1);
        assert.strictEqual(r.rank_premier, -1);
        assert.strictEqual(r.wins_premier, -1);
    }
});

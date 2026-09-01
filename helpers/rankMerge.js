/**
 * Pure rank/wins merge helpers.
 *
 * CS2 rank/wins data arrives from three independent sources that can be
 * interleaved in any order for a single account check:
 *   1. CMsgGCCStrike15_v2_PlayersProfile        (GC msg 9128)
 *   2. CMsgGCCStrike15_v2_ClientGCRankUpdate     (GC msg 9194)
 *   3. GCPD matchmaking HTML (parseMatchmaking)  (web scrape)
 *
 * These helpers centralize the merge rules so the data layer represents every
 * state unambiguously and consistently, and so the logic is unit-testable
 * without a live Steam/GC connection.
 *
 * ---------------------------------------------------------------------------
 * State model (what the renderer html/js/front.js expects):
 *
 *   mm / wingman / dangerzone (getRankImage/getRankName):
 *     - ACTIVE   : rank = 1..N            -> skillgroup<N>.svg
 *     - EXPIRED  : rank = 0 AND wins >= 10 -> *_expired.svg
 *     - UNRANKED : rank = 0 AND wins < 10  -> skillgroup0/none
 *     - VAC/BAN  : rank = -1, wins = -1    -> handled upstream
 *
 *   premier (getRankImage/getRankName with type 'premier'):
 *     - ACTIVE   : rank_premier = rating (>0) -> premier<n>.svg
 *     - EXPIRED  : rank_premier = -1          -> premier_expired.svg
 *     - UNRANKED : rank_premier = 0/null      -> premier_none.svg
 *     - VAC/BAN  : rank_premier = -1 (VAC)    -> handled upstream
 *
 * Note the -1 collision on premier: an expired premier rating and a VAC ban
 * both surface as -1. That is acceptable because a VAC-banned account already
 * shows its ban state elsewhere; the important invariant is that neither state
 * is silently downgraded to "unranked" (0).
 * ---------------------------------------------------------------------------
 */

/**
 * Merge GCPD matchmaking parse output into the account data object.
 *
 * GCPD is a GAP-FILLER for ranks: the GC handlers are authoritative for rank
 * ids, so this function:
 *   - never overwrites a VAC/ban sentinel (rank === -1),
 *   - only fills premier/wingman when GCPD actually has signal for the mode
 *     (the *_present flag is set by parseMatchmaking),
 *   - maps an expired premier (present row, rating 0, wins >= 10) to -1,
 *   - maps an expired wingman (present row, rank 0, wins > 0) to rank 0 with
 *     wins retained so `rank == 0 && wins >= 10` fires in the renderer,
 *   - does not overwrite an already-resolved active value with a GCPD default.
 *
 * Mutates and returns `data`.
 *
 * @param {object} data - account data object (mutated in place)
 * @param {object} mmData - result of parseMatchmaking()
 * @returns {object} data
 */
function mergeGcpdMatchmaking(data, mmData) {
  if (!data || !mmData || !mmData.ok) return data;
  mergeGcpdPremier(data, mmData);
  mergeGcpdWingman(data, mmData);
  return data;
}

/**
 * Merge the premier section of a GCPD parse into `data`. Only runs when GCPD
 * has a present premier row and premier is not already a VAC/ban sentinel.
 * @param {object} data - account data object (mutated in place)
 * @param {object} mmData - result of parseMatchmaking()
 */
function mergeGcpdPremier(data, mmData) {
  if (!mmData.premier_present || data.rank_premier === -1) return;
  if (mmData.premier_rating > 0) {
    data.rank_premier = mmData.premier_rating;
  } else if (mmData.premier_wins >= 10) {
    // Present row, rating 0 but >= 10 prior wins -> expired.
    //
    // The >= 10 threshold intentionally matches the renderer's expired gate
    // for mm/wg/dz (`rank == 0 && wins >= 10`). Premier is the one mode whose
    // expired state is a dedicated sentinel (-1) computed here rather than by
    // the renderer, so it must use the SAME wins threshold as the other modes
    // - otherwise a premier account with 1-9 wins and rating 0 would render
    // "Expired" while the equivalent wingman renders "Unranked". Anything
    // below 10 wins is treated as never-ranked/unranked (rating stays 0),
    // which also prevents a never-ranked premier (GC-set 0) with a stray low
    // GCPD wins count from being flipped to expired.
    //
    // Do not overwrite a real active rating GC may already have set.
    if (data.rank_premier == null || data.rank_premier <= 0) {
      data.rank_premier = -1;
    }
  }
  if (mmData.premier_wins > 0) {
    data.wins_premier = mmData.premier_wins;
  }
}

/**
 * Merge the wingman section of a GCPD parse into `data`. Only runs when GCPD
 * has a present wingman row and wingman is not already a VAC/ban sentinel.
 * @param {object} data - account data object (mutated in place)
 * @param {object} mmData - result of parseMatchmaking()
 */
function mergeGcpdWingman(data, mmData) {
  if (!mmData.wingman_present || data.rank_wg === -1) return;
  if (mmData.wingman_rank > 0) {
    data.rank_wg = mmData.wingman_rank;
  } else if (mmData.wingman_wins > 0) {
    // Expired: keep rank 0 so the renderer's `rank == 0 && wins >= 10`
    // expired check fires. Only set 0 when GC has not provided a real rank.
    if (data.rank_wg == null || data.rank_wg <= 0) {
      data.rank_wg = 0;
    }
  }
  if (mmData.wingman_wins > 0) {
    data.wins_wg = mmData.wingman_wins;
  }
}

/**
 * Apply one PlayerRankingInfo entry (from PlayersProfile or ClientGCRankUpdate)
 * onto the data object.
 *
 * A ranking ENTRY existing for a rank_type_id is the authoritative signal that
 * CS2 reported that mode. Because protobufjs decodes unset numeric fields to 0
 * (defaults:true), an EXPIRED rank legitimately arrives as rank_id === 0 with
 * wins > 0 - so we assign unconditionally rather than using truthiness guards
 * that would drop the expired state. VAC/ban sentinels (-1) already on the data
 * object are never overwritten.
 *
 * VAC cascade: when competitive is VAC-banned, CS2's secondary modes are also
 * banned. The ClientGCRankUpdate (9194) handler in main.js cascades a
 * competitive VAC into wingman/dz/premier; this function replicates that rule
 * so behavior is identical regardless of which GC message (9128 vs 9194)
 * resolves the account. The cascade is applied both when a secondary entry
 * arrives after competitive was already VAC, and retroactively (via
 * cascadeVac) when the competitive VAC entry itself arrives - so it is
 * order-independent. It triggers ONLY on the genuine VAC sentinel (both
 * data.rank === -1 and data.wins === -1), never on a legitimate expired /
 * unranked rank_id 0.
 *
 * The secondary GC modes (wingman 7, danger zone 10, premier 11) share
 * identical apply logic, so their (rank, wins) target keys live in a lookup
 * table instead of a switch. Competitive (type 6) stays special-cased because
 * it drives the VAC cascade.
 *
 * @param {object} data - account data object (mutated in place)
 * @param {object} ranking - a PlayerRankingInfo-like object
 * @returns {object} data
 */
const GC_MODE_KEYS = {
  7: ['rank_wg', 'wins_wg'],
  10: ['rank_dz', 'wins_dz'],
  11: ['rank_premier', 'wins_premier']
};

function applyGcRanking(data, ranking) {
  if (!data || !ranking) return data;
  const rankId = ranking.rank_id ?? 0;
  const rankWins = ranking.wins ?? 0;

  if (ranking.rank_type_id === 6) {
    if (data.rank !== -1) {
      data.rank = rankId;
      data.wins = rankWins;
    }
    cascadeVac(data);
    return data;
  }

  const keys = GC_MODE_KEYS[ranking.rank_type_id];
  if (keys) {
    applySecondaryMode(data, keys[0], keys[1], rankId, rankWins);
  }
  return data;
}

/**
 * Apply a secondary-mode (wingman/dz/premier) ranking entry: write the incoming
 * rank/wins unless the mode already carries a VAC/ban sentinel (-1), then apply
 * the competitive-VAC cascade so a banned competitive forces the secondary mode
 * to the sentinel. Identical logic for all three secondary modes.
 * @param {object} data - account data object (mutated in place)
 * @param {string} rankKey - property name for the mode's rank (e.g. 'rank_wg')
 * @param {string} winsKey - property name for the mode's wins (e.g. 'wins_wg')
 * @param {number} rankId - incoming rank id
 * @param {number} rankWins - incoming wins
 */
function applySecondaryMode(data, rankKey, winsKey, rankId, rankWins) {
  if (data[rankKey] !== -1) { data[rankKey] = rankId; data[winsKey] = rankWins; }
  if (isCompetitiveVac(data)) { data[rankKey] = -1; data[winsKey] = -1; }
}

/**
 * True only when competitive is the genuine VAC/ban sentinel. The competitive
 * VAC sentinel is set as rank = -1 AND wins = -1 (see the 9110 handler in
 * main.js). Requiring both guards against treating a legitimate expired /
 * unranked competitive rank (rank_id 0) as a ban.
 *
 * @param {object} data - account data object
 * @returns {boolean}
 */
function isCompetitiveVac(data) {
  return data.rank === -1 && data.wins === -1;
}

/**
 * Cascade a competitive VAC into the secondary modes (wingman/dz/premier),
 * matching the 9194 handler. Only overwrites secondary modes that carry actual
 * values (not still-null) so it does not fabricate modes CS2 never reported;
 * modes CS2 does report on a VAC account arrive as their own entries and get
 * the sentinel applied in applyGcRanking's per-mode branches.
 *
 * @param {object} data - account data object (mutated in place)
 * @returns {object} data
 */
function cascadeVac(data) {
  if (!isCompetitiveVac(data)) return data;
  if (data.rank_wg != null) { data.rank_wg = -1; data.wins_wg = -1; }
  if (data.rank_dz != null) { data.rank_dz = -1; data.wins_dz = -1; }
  if (data.rank_premier != null) { data.rank_premier = -1; data.wins_premier = -1; }
  return data;
}

/**
 * Data-driven descriptor for ClientGCRankUpdate (GC msg 9194) rank_type_id
 * handling. Each entry names the rank/wins fields the mode writes, the
 * console.log label, and two behavioral flags:
 *   vacCascade          - after assigning, if data.wins === -1 (VAC) force this
 *                         mode's rank/wins to -1;
 *   premierExpiredGuard - only overwrite the rank field when it is not already
 *                         the expired premier sentinel -1 (rank_id carries the
 *                         RATING for premier; the expired -1 is derived from the
 *                         GCPD path and must not be clobbered here).
 * Mirrors the original four repeated if-blocks in main.js exactly.
 */
const GC_RANK_UPDATE_TYPES = {
  6:  { rank: 'rank',         wins: 'wins',         label: 'Competitive rank' },
  7:  { rank: 'rank_wg',      wins: 'wins_wg',      label: 'Wingman rank',     vacCascade: true },
  10: { rank: 'rank_dz',      wins: 'wins_dz',      label: 'Danger Zone rank', vacCascade: true },
  11: { rank: 'rank_premier', wins: 'wins_premier', label: 'Premier rank',     vacCascade: true, premierExpiredGuard: true }
};

/**
 * Apply a single ClientGCRankUpdate (GC msg 9194) ranking entry to `data` using
 * the descriptor table. Assignment is UNCONDITIONAL when an entry exists (an
 * EXPIRED rank arrives as rank_id 0 with wins > 0, which the frontend reads as
 * expired via `rank == 0 && wins >= 10`); undefined is normalized to 0 so we
 * never write undefined. This is the 9194 counterpart to applyGcRanking (which
 * covers the 9128 PlayersProfile path); the two differ only in the premier
 * expired-guard / VAC-cascade shape that mirrors the original inline handlers.
 *
 * The optional `log` callback is invoked as log(label, rankValue, winsValue)
 * AFTER the assignment and BEFORE the VAC cascade, matching the original
 * console.log placement. It is a no-op when omitted.
 *
 * @param {object} data - account data object (mutated in place)
 * @param {object} ranking - a PlayerRankingInfo-like object
 * @param {function(string, number, number):void} [log] - optional log callback
 * @returns {object} data
 */
/**
 * Write the rank field for a 9194 entry, honoring the premier expired-guard.
 * When premierExpiredGuard is set, do not clobber an expired premier sentinel
 * (-1) already set by the GCPD path (which has the wins signal to distinguish
 * expired from never-ranked); otherwise assign unconditionally.
 *
 * @param {object} data - account data object (mutated in place)
 * @param {object} spec - GC_RANK_UPDATE_TYPES descriptor
 * @param {number} rankId - normalized rank_id to write
 */
function writeRankRespectingPremierGuard(data, spec, rankId) {
  if (spec.premierExpiredGuard && data[spec.rank] === -1) return;
  data[spec.rank] = rankId;
}

/**
 * Apply the competitive-VAC cascade for a single secondary mode: when the mode
 * cascades and the primary competitive result is VAC (data.wins === -1), force
 * this mode's rank/wins to -1. No-op otherwise.
 *
 * @param {object} data - account data object (mutated in place)
 * @param {object} spec - GC_RANK_UPDATE_TYPES descriptor
 */
function applyVacCascadeForMode(data, spec) {
  if (spec.vacCascade && data.wins === -1) { // vac banned
    data[spec.wins] = -1;
    data[spec.rank] = -1;
  }
}

function applyGcRankUpdateEntry(data, ranking, log) {
  if (!data || !ranking) return data;
  const spec = GC_RANK_UPDATE_TYPES[ranking.rank_type_id];
  if (!spec) return data;

  data[spec.wins] = ranking.wins ?? 0;
  writeRankRespectingPremierGuard(data, spec, ranking.rank_id ?? 0);

  if (typeof log === 'function') {
    log(spec.label, data[spec.rank], data[spec.wins]);
  }

  applyVacCascadeForMode(data, spec);

  return data;
}

module.exports = {
  mergeGcpdMatchmaking,
  applyGcRanking,
  applyGcRankUpdateEntry
};

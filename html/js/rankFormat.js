// Pure rank/format helpers for the renderer.
//
// This file is a plain (non-module) <script> loaded BEFORE html/js/front.js in
// html/index.html, so every function/const declared here at top level is a
// renderer global that front.js consumes directly - identical to when this
// code lived inline in front.js. Nothing here touches the DOM or renderer
// state; it depends only on universal globals (Date, Number, Math, parseInt,
// Object, console), so it is safe to load first. Behavior is byte-for-behavior
// identical to the original inline definitions - do NOT change any string,
// threshold, or the deliberate rank/wins/premier semantics.

// Image-name prefixes per rank type (under img/skillgroups/).
const RANK_IMAGE_PREFIXES = {
  mm: 'skillgroup',
  wg: 'wingman',
  dz: 'dangerzone',
  premier: 'premier'
};

// Premier rating buckets, in order. Each entry maps a [min, max] inclusive
// rating range to the image suffix number and the label range shown in the
// tooltip. max === Infinity is the open-ended top bucket (30000+).
const PREMIER_BUCKETS = [
  { min: 1, max: 4999, image: '1', label: '1-4999' },
  { min: 5000, max: 9999, image: '2', label: '5000-9999' },
  { min: 10000, max: 14999, image: '3', label: '10000-14999' },
  { min: 15000, max: 19999, image: '4', label: '15000-19999' },
  { min: 20000, max: 24999, image: '5', label: '20000-24999' },
  { min: 25000, max: 29999, image: '6', label: '25000-29999' },
  { min: 30000, max: Infinity, image: '7', label: '30000+' }
];

/**
 * Find the premier bucket for a rating, or null if the rating is not a positive
 * in-range value.
 * @param {Number} rank premier rating
 * @returns {{min:Number, max:Number, image:String, label:String}|null}
 */
function findPremierBucket(rank) {
  return PREMIER_BUCKETS.find(b => rank >= b.min && rank <= b.max) || null;
}

/**
 * True when a premier rating value represents the unranked/none state (empty
 * cell, null/undefined, or 0).
 *
 * `rank` can arrive either as a Number or as a numeric/empty string from stored
 * or table-parsed account data (an empty table cell surfaces as ''), so the
 * `=== ''` guard is intentional and load-bearing, not dead code. The JSDoc type
 * reflects both shapes.
 * @param {Number|string} rank
 * @returns {Boolean}
 */
function isPremierUnranked(rank) {
  return rank === null || rank === undefined || rank === 0 || rank === '';
}

/**
 * Get correct image name for given rank
 * @param {Number} rank ranking
 * @param {Number} wins number of wins
 * @param {'mm' | 'wg' | 'dz' | 'premier'} type rank type 
 * @returns {String}
 */
function getRankImage(rank, wins, type) {
  const prefix = 'img/skillgroups/' + (RANK_IMAGE_PREFIXES[type] ?? '');

  if (type === 'premier') {
    // Для Premier используем ранги на основе рейтинга

    // Проверяем на истекший ранг (-1)
    if (rank === -1) {
      console.log('Premier expired rank detected (-1)');
      return prefix + '_expired.svg'; // Истекший ранг
    }
    // Проверяем на пустую ячейку таблицы или неранжированный статус
    if (isPremierUnranked(rank)) {
      return prefix + '_none.svg'; // Неранжированный
    }
    const bucket = findPremierBucket(rank);
    if (bucket) {
      return prefix + bucket.image + '.svg';
    }
    return undefined;
  }

  // Для других режимов используем стандартную логику
  if (rank <= 0) {
    rank = 0;
  }
  // rank may arrive as a number or a numeric string from stored data; normalize
  // before the zero check so expired-rank detection (rank 0 with >= 10 wins) holds.
  if (Number(rank) === 0 && wins >= 10) {
    return prefix + '_expired.svg';
  }
  return prefix + rank + '.svg';
}

/**
 * Get rank name for given rank id
 * @param {Number} rank ranking
 * @param {Number} wins number of wins
 * @returns {String} rank name
 */
/**
 * Get rank name for given rank id
 * @param {Number} rank ranking
 * @param {Number} wins number of wins
 * @param {'mm' | 'wg' | 'dz' | 'premier'} type rank type (optional)
 * @returns {String} rank name
 */
// Competitive (mm) skill-group names keyed by rank id.
const MM_RANK_NAMES = {
  1: "Silver 1",
  2: "Silver 2",
  3: "Silver 3",
  4: "Silver 4",
  5: "Silver Elite",
  6: "Silver Elite Master",
  7: "Gold Nova 1",
  8: "Gold Nova 2",
  9: "Gold Nova 3",
  10: "Gold Nova Master",
  11: "Master Guardian 1",
  12: "Master Guardian 2",
  13: "Master Guardian Elite",
  14: "Distinguished Master Guardian",
  15: "Legendary Eagle",
  16: "Legendary Eagle Master",
  17: "Supreme Master First Class",
  18: "Global Elite CS GO"
};

/**
 * Build the Premier rank name for a rating.
 * @param {Number} rank premier rating
 * @returns {String}
 */
function getPremierRankName(rank) {
  // Проверяем на истекший ранг (-1)
  if (rank === -1) {
    return "Premier Rating: Expired";
  }
  // Проверяем на пустую ячейку таблицы или неранжированный статус
  if (isPremierUnranked(rank)) {
    return "Unranked";
  }
  const bucket = findPremierBucket(rank);
  if (bucket) {
    return `Premier Rating: ${rank} (${bucket.label})`;
  }
  return `Premier Rating: ${rank}`;
}

function getRankName(rank, wins, type) {
  // Если это Premier ранг, используем специальную логику
  if (type === 'premier') {
    return getPremierRankName(rank);
  }

  // Для других режимов используем стандартную логику
  if (rank <= 0) {
    rank = 0;
  }
  if (rank === 0) {
    return wins >= 10 ? "Expired" : "Unranked";
  }
  // Match the original strict `switch (rank)` semantics: only an exact numeric
  // rank id maps to a name; anything else (incl. numeric strings) is Unknown.
  return Object.prototype.hasOwnProperty.call(MM_RANK_NAMES, rank) && typeof rank === 'number'
    ? MM_RANK_NAMES[rank]
    : `Unknown(${rank})`;
}

/**
 * Get danger zone rank name for given rank id
 * @param {Number} rank ranking
 * @param {Number} wins number of wins
 * @returns {String} rank name
 */
// Danger Zone rank names keyed by rank id.
const DZ_RANK_NAMES = {
  1: "Lab Rat I",
  2: "Lab Rat II",
  3: "Sprinting Hare I",
  4: "Sprinting Hare II",
  5: "Wild Scout I",
  6: "Wild Scout II",
  7: "Wild Scout Elite",
  8: "Hunter Fox I",
  9: "Hunter Fox II",
  10: "Hunter Fox Elite",
  11: "Timber Wolf",
  12: "Ember Wolf",
  13: "Wildfire Wolf",
  14: "The Howling Alpha"
};

 function getDZRankName(rank, wins) {
  if (rank <= 0) {
    rank = 0;
  }
  if (rank === 0) {
    return wins >= 1 ? "Expired or Unranked" : "Unranked";
  }
  // Match the original strict `switch (rank)` semantics.
  return Object.prototype.hasOwnProperty.call(DZ_RANK_NAMES, rank) && typeof rank === 'number'
    ? DZ_RANK_NAMES[rank]
    : `Unknown(${rank})`;
}

/**
 * Format countdown string
 * @param {Number} seconds seconds remaining
 * @returns formatted string
 */
function countdown(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  seconds -= d * 3600 * 24;
  const h = Math.floor(seconds / 3600);
  seconds -= h * 3600;
  const m = Math.floor(seconds / 60);
  seconds -= m * 60;
  const tmp = [];
  (d) && tmp.push(d + 'd');
  (d || h) && tmp.push(h + 'h');
  (d || h || m) && tmp.push(m + 'm');
  tmp.push(seconds + 's');
  return tmp.join(' ');
}

/**
 * Format account penalty
 * @param {String | Number} reason penalty reason
 * @param {Number} seconds Seconds left
 * @returns {String}
 */
function formatPenalty(reason, seconds) {
  if (reason === 0) {
    return '-';
  }
  if (seconds == -1) {
    return reason;
  }
  if (Date.now() > seconds * 1000 || new Date(seconds * 1000).getFullYear() - new Date().getFullYear() > 100) {
    return reason + ' - Expired';
  }
  return reason + ' - ' + countdown(seconds - Math.floor(Date.now() / 1000));
}

/**
 * Formats rank expire time from last played match date
 * @param {Date} time
 * @returns {String}
 */
function formatExpireTime(time) {
  console.log('Original date:', time);
  
  // Проверяем, что дата валидна
  if (!(time instanceof Date && !isNaN(time))) {
    console.error('Invalid date provided to formatExpireTime');
    return 'Invalid date';
  }
  
  time = new Date(time.getTime());
  console.log('Converted date:', time);
  //https://github.com/dumbasPL/csgo-checker/issues/3#issuecomment-827474759
  //this is untested yet, i'm trusting what this guy says.
  time.setDate(time.getDate() + 30);
  console.log('Expire date:', time);
  
  // Форматируем дату вручную для большей надежности
  let day = time.getDate().toString().padStart(2, '0');
  let month = (time.getMonth() + 1).toString().padStart(2, '0');
  let year = time.getFullYear();
  let hours = time.getHours().toString().padStart(2, '0');
  let minutes = time.getMinutes().toString().padStart(2, '0');
  
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

// credit: https://stackoverflow.com/a/11868398/5861427
/**
 * Calculates the text color for a given background color based on brightness
 * @param {String} color the background color
 * @returns {'black' | 'white'} text color
 */
function getContrastYIQ(color) {
  color = color.trim().replace('#', '');
  var r = parseInt(color.substr(0, 2), 16);
  var g = parseInt(color.substr(2, 2), 16);
  var b = parseInt(color.substr(4, 2), 16);
  var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
  return (yiq >= 128) ? 'black' : 'white';
}

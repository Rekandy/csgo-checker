const { equal } = fastEqual;

let version;
ipcRenderer.invoke("app:version").then(v => {
  version = v;
  document.title += " " + v;
});

let account_cache = {};
let tags_cache = {};
let encrypted = false;

// The pure rank/format helpers (RANK_IMAGE_PREFIXES, PREMIER_BUCKETS,
// findPremierBucket, isPremierUnranked, getRankImage, MM_RANK_NAMES,
// getPremierRankName, getRankName, DZ_RANK_NAMES, getDZRankName, countdown,
// formatPenalty, formatExpireTime, getContrastYIQ) live in html/js/rankFormat.js,
// which is loaded as a <script> BEFORE this file in html/index.html. They are
// renderer globals used unchanged throughout front.js.

/**
 * Create a pill badge
 * @param {String} text Text to be displayed
 * @param {String} color Color of the badge
 * @returns {Element}
 */
function createBadge(text, color) {
  let newBadge = document.querySelector('#badge-template').content.cloneNode(true);
  let span = newBadge.querySelector('span');
  span.innerText = text;
  span.style.backgroundColor = color;
  span.style.color = getContrastYIQ(color);
  return newBadge;
}

/**
 * show a toast message
 * @param {String} text text to show
 * @param {String} color bs color
 * @param {Boolean} permanent is the toast permanent
 */
function showToast(text, color, permanent = false) {
  let newToast = document.querySelector('#toast-template').content.cloneNode(true);
  newToast.querySelector('.toast-body').innerHTML = text;
  let fg = 'white';
  switch (color) {
    case 'warning':
    case 'info':
    case 'light':
    case 'body':
    case 'white':
    case 'transparent':
      fg = 'dark';
      break;
  }
  let toast_div = newToast.querySelector('.toast');
  toast_div.classList.add('text-' + fg);
  toast_div.classList.add('bg-' + color);
  if (!permanent) {
    toast_div.querySelector('button.btn-close').remove();
  }

  document.querySelector('.toast-container').appendChild(newToast);

  toast_div.addEventListener('hidden.bs.toast', () => {
    toast_div.remove();
  })
  let toast = new bootstrap.Toast(toast_div, {
    delay: 2000,
    autohide: !permanent,
  });
  toast.show();
}

/**
 * @param {String} name tag name
 * @param {String} color tag color
 * @returns {Element} new line
 */
function createTagEdit(name, color = '#000000') {
  let new_line = document.querySelector('#settings-tags-template').content.cloneNode(true).querySelector('.row');
  new_line.id = 'tag-edit-' + name;
  new_line.querySelector('input[type=text]').value = name;
  new_line.querySelector('input[type=color]').value = color;
  new_line.querySelector('button').addEventListener('click', e => {
    e.preventDefault();
    new_line.remove();
  });
  return new_line;
}

/**
 * Checks if account matches query string
 * @param {String} q query
 * @param {String} login account login
 * @param {*} account account object
 * @returns {Boolean} matches? 
 */
/**
 * Rank-related searchable strings for an account (mm, wingman, danger zone).
 * Kept faithful to the original inline expressions, including the `?? 0`
 * defaults so an expired/unranked account still matches its rank label.
 * @param {*} account account object
 * @returns {Array<String>} rank name strings
 */
function buildRankSearchStrings(account) {
  return [
    getRankName(account.rank ?? 0, account.wins ?? 0),
    getRankName(account.rank_wg ?? 0, account.wins_wg ?? 0),
    getDZRankName(account.rank_dz ?? 0, account.wins_dz ?? 0)
  ];
}

/**
 * Identity/status searchable strings for an account (name, tags, prime,
 * error, penalty, steamid). Faithful to the original inline order and the
 * deliberate null entries; the search's own `v &&` guard skips the nulls.
 * @param {String} login account login
 * @param {*} account account object
 * @returns {Array} searchable strings (may contain nulls)
 */
function buildIdentitySearchStrings(login, account) {
  const strings = [login, account.name ?? null];
  if (account.tags) {
    account.tags.forEach(tag => strings.push(tag));
  }
  strings.push(account.prime ? "prime" : null);
  strings.push(account.error ?? null);
  strings.push(formatPenalty(account.penalty_reason ?? '?', account.penalty_seconds ?? -1));
  strings.push(account.steamid ? "" + account.steamid : null);
  return strings;
}

/**
 * Build the list of searchable strings for an account. Pure: the returned
 * array (including the deliberate null entries) is exactly what execSearch
 * matches against; the search's own `v &&` guard skips the nulls.
 * @param {String} login account login
 * @param {*} account account object
 * @returns {Array} searchable strings (may contain nulls)
 */
function buildSearchStrings(login, account) {
  return [
    ...buildIdentitySearchStrings(login, account),
    ...buildRankSearchStrings(account)
  ];
}

function execSearch(q, login, account) {

  q = q.trim();
  if (q.length == 0) {
    return true;
  }

  let strings = buildSearchStrings(login, account);

  return q.toLowerCase().split(' ').map(x => {
    return strings.find(v => v && v.toLowerCase().includes(x)) != undefined
  }).reduce((prev, cur) => prev && cur, true);
}

/**
 * @type {HTMLElement}
 */
let LastClickedColumn;

/**
 * Advance the sort direction one step in the none -> DESC -> ASC -> none cycle.
 * @param {String} cur current sort direction ('none' | 'DESC' | 'ASC')
 * @returns {String} next sort direction
 */
function nextSortDir(cur) {
  switch (cur) {
    case 'none': return 'DESC';
    case 'DESC': return 'ASC';
    default: return 'none'; // same as case 'ASC'
  }
}

// Per-column value transforms applied (on a shallow clone) before sorting, so
// certain columns sort by a derived/normalized value. Columns not listed here
// sort by their raw value. Each transform mutates the provided clone in place.
const SORT_COLUMN_TRANSFORMS = {
  //combine bans and errors
  ban: clone => { clone.ban = clone.error ?? formatPenalty(clone.penalty_reason ?? '?', clone.penalty_seconds ?? -1); },
  // Специальная обработка для уровня
  lvl: clone => { clone.lvl = clone.lvl ?? 0; },
  rank: (clone, col) => { clone[col] = Math.max(clone[col], 0); }, //clap -1 to 0 so sorting works correctly
  rank_dz: (clone, col) => { clone[col] = Math.max(clone[col], 0); },
  rank_wg: (clone, col) => { clone[col] = Math.max(clone[col], 0); },
  rank_premier: (clone, col) => { clone[col] = Math.max(clone[col], 0); },
  prime: clone => { clone.prime = clone.prime ? 1 : 0; } //convert to integer
};

/**
 * Compare two cell values for sorting.
 *
 * Numeric columns (rank/lvl/prime, normalized by SORT_COLUMN_TRANSFORMS) still
 * sort numerically. String columns use localeCompare for a reliable,
 * locale-aware alphabetical order instead of the byte-wise `>` operator that
 * SonarQube flags as unreliable. The ascending order this produces is later
 * reversed for DESC by the caller, matching the previous behavior.
 * @param {*} a
 * @param {*} b
 * @returns {Number} negative if a<b, positive if a>b, 0 if equal
 */
function compareSortValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

/**
 * Compute the ordered list of account logins for the given column and sort
 * direction, applying any per-column value transform first.
 * @param {String} col_name column data name
 * @param {String} new_sort_dir 'none' | 'DESC' | 'ASC'
 * @returns {String[]} ordered logins
 */
function computeSortOrder(col_name, new_sort_dir) {
  //special case as username is they key
  if (col_name == "username") {
    let usernames = Object.keys(account_cache);
    if (new_sort_dir != 'none') {
      usernames.sort();
    }
    if (new_sort_dir == 'DESC') {
      usernames.reverse();
    }
    return usernames;
  }

  let accounts = Object.entries(account_cache);
  const transform = SORT_COLUMN_TRANSFORMS[col_name];
  if (transform) {
    accounts = accounts.map(a => {
      let clone = Object.assign({}, a[1]);
      transform(clone, col_name);
      return [a[0], clone];
    });
  }
  if (new_sort_dir != 'none') {
    accounts.sort((a, b) => compareSortValues(a[1][col_name], b[1][col_name]));
  }
  if (new_sort_dir == 'DESC') {
    accounts.reverse();
  }
  return accounts.map(a => a[0]);
}

/**
 * Handle sorting
 * @param {HTMLElement} elem clicked element
 * @param {Boolean} increment change sorting direction
 */
function handleSort(elem, increment = true) {
  LastClickedColumn = elem;

  while (elem.tagName != 'TH') {
    elem = elem.parentNode;
  }

  let col_name = elem.dataset.columnName;
  let cur_sort_dir = elem.dataset.sortDir;

  if (!col_name) {
    return;
  }

  let new_sort_dir = increment ? nextSortDir(cur_sort_dir) : cur_sort_dir;

  let new_order = computeSortOrder(col_name, new_sort_dir);

  document.querySelectorAll('#main-table th.sortable').forEach(e => e.dataset.sortDir = 'none');
  elem.dataset.sortDir = new_sort_dir;

  let tbody = document.querySelector('#main-table tbody');
  new_order.forEach(login => {
    let node = document.getElementById('acc-' + login);
    tbody.insertBefore(node, null);
  })
}

/**
 * Called when a new table row is created
 * @callback createCallback
 * @param {Element} tr newly created table row 
 */

/**
 * Tries to find and creates if not found a table row corresponding to an account
 * @param {String} login login
 * @param {createCallback} createCallback
 * @returns {Element} table row
 */
function FindOrCreateRow(login, createCallback) {
  let table_body = document.querySelector('#main-table tbody');

  let tr = document.getElementById('acc-' + login);
  if (!tr) {
    let template = document.querySelector('#row-template');
    tr = template.content.cloneNode(true).querySelector('tr');
    tr.id = 'acc-' + login;
    tr.querySelector('td.login').innerText = login;
    tr.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => new bootstrap.Tooltip(el, { trigger: 'hover' }));

    if (createCallback) {
      createCallback(tr);
    }

    table_body.appendChild(tr);
  }
  return tr;
}

/**
 * Update row with new data
 * @param {Element} row the row to update
 * @param {String} login account login
 * @param {*} account account data
 * @param {Boolean} force force update
 * @returns {Boolean} account data changed
 */
/**
 * Render the steam name and tag badges for a row.
 * @param {Element} row
 * @param {*} account
 */
function renderRowTags(row, account) {
  row.querySelector('.steam-name').innerText = account.name || '?';
  let tags = row.querySelector('.tags')
  while (tags.firstChild) {
    tags.firstChild.remove();
  }
  if (account.tags) {
    account.tags.forEach(tag => {
      let color = tags_cache[tag];
      if (!color) {
        color = '#000000';
      }
      let badge = createBadge(tag, color);
      tags.appendChild(badge);
    });
  }
}

/**
 * Render the profile level, rank badge, and XP progress cell for a row.
 * @param {Element} row
 * @param {*} account
 */
function renderRowLevel(row, account) {
  // Обновляем шкалу прогресса опыта
  let expProgress = row.querySelector('.level .progress-bar');
  let expText = row.querySelector('.level .exp-value');
  let levelValue = row.querySelector('.level .level-value');
  let rankIcon = row.querySelector('.level .rank-icon');

  // Обновляем уровень профиля и значок ранга.
  // CS2 profile levels start at 1, so a value of 0/null/undefined means the
  // level is unknown/unavailable (never fetched or the data source returned
  // nothing). Render 'N/A' instead of a misleading "0" with a fake rank icon.
  let level = account.lvl ?? 0;
  let levelKnown = Number.isFinite(level) && level >= 1;
  levelValue.innerText = levelKnown ? level : 'N/A';

  if (levelKnown) {
      // Определяем номер значка ранга (от 1 до 40)
      let rankNumber = Math.min(Math.max(level, 1), 40);
      rankIcon.src = `img/ranks/${rankNumber}.png`;
      rankIcon.style.display = '';
  } else {
      // Hide the rank badge entirely rather than implying rank 1.
      rankIcon.style.display = 'none';
  }

  // Обновляем прогресс опыта. Only meaningful when the level is known;
  // otherwise show 'N/A' rather than a stale "0/5000".
  if (levelKnown && account.exp !== undefined && account.exp !== null) {
      let expPercent = (account.exp / 5000) * 100;
      expProgress.style.width = `${expPercent}%`;
      expProgress.setAttribute('aria-valuenow', account.exp);
      expText.innerText = account.exp;
  } else if (levelKnown) {
      expProgress.style.width = '0%';
      expProgress.setAttribute('aria-valuenow', 0);
      expText.innerText = '0';
  } else {
      expProgress.style.width = '0%';
      expProgress.setAttribute('aria-valuenow', 0);
      expText.innerText = 'N/A';
  }
}

/**
 * Apply the Prime icon color for a row based on rank presence / verification.
 * @param {Element} row
 * @param {String} login
 * @param {*} account
 */
function renderRowPrime(row, login, account) {
  // Отладочный код для проверки значений рангов
  console.log('Account:', login, 'Ranks:', {
    rank: account.rank,
    rank_wg: account.rank_wg,
    rank_dz: account.rank_dz,
    rank_premier: account.rank_premier
  });

  // Проверяем, есть ли хотя бы один ненулевой ранг
  const hasNonZeroRank = account.rank !== 0 || account.rank_wg !== 0 || account.rank_dz !== 0 || account.rank_premier !== 0;
  console.log('Has non-zero rank:', hasNonZeroRank);

  // Применяем стили к значку Prime
  const primeImg = row.querySelector('.prime img.prime-icon');
  if (account.steamid) {
    if (hasNonZeroRank) {
      // Зеленый цвет для аккаунтов с Prime
      primeImg.className = 'prime-icon prime-green';
      console.log('Applied green color to Prime icon');
    } else {
      // Красный цвет для аккаунтов без Prime
      primeImg.className = 'prime-icon prime-red';
      console.log('Applied red color to Prime icon');
    }
  } else {
    // Белый цвет для непроверенных аккаунтов
    primeImg.className = 'prime-icon';
    console.log('Applied white color to Prime icon');
  }
}

/**
 * Build the premier "last match" tooltip suffix for a row, or '' when there is
 * no premier date.
 * @param {*} account
 * @returns {String}
 */
function premierExpireSuffix(account) {
  // Используем новый формат даты
  if (!account.premier_date) {
    return '';
  }
  console.log('Premier date object for ' + account.name + ':', account.premier_date);

  let d = account.premier_date;

  // Создаем дату последней игры
  let lastGameDate = new Date(d.year, d.month - 1, d.day, d.hours, d.minutes, d.seconds);
  console.log('Last game date for ' + account.name + ':', lastGameDate);

  // Форматируем дату последней игры
  let day = lastGameDate.getDate().toString().padStart(2, '0');
  let month = (lastGameDate.getMonth() + 1).toString().padStart(2, '0');
  let year = lastGameDate.getFullYear();
  let hours = lastGameDate.getHours().toString().padStart(2, '0');
  let minutes = lastGameDate.getMinutes().toString().padStart(2, '0');

  return `<br>last match ${day}.${month}.${year} ${hours}:${minutes}`;
}

/**
 * Build the "<br>expires ..." tooltip suffix for a mode's last-game timestamp,
 * or '' when there is no timestamp. Mirrors the original inline expression for
 * the mm/wg/dz modes exactly.
 * @param {*} lastGame last-game value (timestamp/date-parsable), or falsy
 * @returns {String}
 */
function expireSuffix(lastGame) {
  return lastGame ? '<br>expires ' + formatExpireTime(new Date(lastGame)) : '';
}

/**
 * Render the rank images and tooltips for all four modes on a row.
 * @param {Element} row
 * @param {*} account
 */
function renderRowRanks(row, account) {
  // NOTE: the dz image uses bare `account.wins_dz` (no `?? 0`) while every
  // other mode uses `?? 0`, and only the mm title guards `wins < 0`. This
  // asymmetry is deliberate and hard-won; keep it intact.
  row.querySelector('.rank .mm').src = getRankImage(account.rank ?? 0, account.wins ?? 0, 'mm');
  row.querySelector('.rank .wg').src = getRankImage(account.rank_wg ?? 0, account.wins_wg ?? 0, 'wg');
  row.querySelector('.rank .dz').src = getRankImage(account.rank_dz ?? 0, account.wins_dz, 'dz');
  row.querySelector('.rank .premier').src = getRankImage(account.rank_premier ?? 0, account.wins_premier ?? 0, 'premier');

  let mm_expire = expireSuffix(account.last_game);
  let wg_expire = expireSuffix(account.last_game_wg);
  let dz_expire = expireSuffix(account.last_game_dz);
  let premier_expire = premierExpireSuffix(account);

  row.querySelector('.rank .mm').title = getRankName(account.rank ?? 0, account.wins ?? 0) +
    '<br>' + (account.wins < 0 ? '?' : account.wins ?? '?') + ' wins' + mm_expire;
  row.querySelector('.rank .wg').title = getRankName(account.rank_wg ?? 0, account.wins_wg ?? 0) +
    '<br>' + (account.wins_wg ?? '?') + ' wins' + wg_expire;
  row.querySelector('.rank .dz').title = getDZRankName(account.rank_dz ?? 0, account.wins_dz ?? 0) +
    '<br>' + (account.wins_dz ?? '?') + ' wins' + dz_expire;
  row.querySelector('.rank .premier').title = getRankName(account.rank_premier ?? 0, account.wins_premier ?? 0, 'premier') +
    '<br>' + (account.wins_premier ?? '?') + ' wins' + premier_expire;


  bootstrap.Tooltip.getInstance(row.querySelector('.rank .mm'))._fixTitle();
  bootstrap.Tooltip.getInstance(row.querySelector('.rank .wg'))._fixTitle();
  bootstrap.Tooltip.getInstance(row.querySelector('.rank .dz'))._fixTitle();
  bootstrap.Tooltip.getInstance(row.querySelector('.rank .premier'))._fixTitle();
}

/**
 * Render the ban/error cell and the per-account action buttons for a row.
 * @param {Element} row
 * @param {*} account
 */
function renderRowBanAndActions(row, account) {
  row.querySelector('.ban').innerText = banCellText(account);
  row.querySelector(".copy-steamguard").style.display = account.sharedSecret ? 'initial' : 'none';
  row.querySelector('.copy-code').style.display = 'inline-block';
  row.querySelector('.open-pofile').style.display = 'inline-block';
}

// Ban-cell text for an active penalty: an explicit error wins, otherwise the
// formatted penalty. Mirrors the renderRowBanAndActions expression exactly.
function banCellText(account) {
  return account.error ?? formatPenalty(account.penalty_reason ?? '?', account.penalty_seconds ?? -1);
}

// True when the ban cell should be cleared: no active penalty timer, no error,
// and no meaningful penalty reason. Preserves the original compound condition.
function shouldClearBanText(account) {
  return !account.error && (!account.penalty_reason || account.penalty_reason === '?');
}

function updateBanText(row, account) {
  const banEl = row.querySelector('.ban');
  if (!banEl) return;
  if (account.penalty_seconds > 0) {
    banEl.innerText = banCellText(account);
  } else if (shouldClearBanText(account)) {
    banEl.innerText = '';
  }
}

function updateRow(row, login, account, force) {
  let changed = false;
  if (!equal(account_cache[login], account) || force) {
    account_cache[login] = account;

    row.className = account.pending ? 'pending' : '';

    renderRowTags(row, account);
    renderRowLevel(row, account);
    renderRowPrime(row, login, account);
    renderRowRanks(row, account);
    renderRowBanAndActions(row, account);

    changed = true;
  }

  updateBanText(row, account);
  return changed;
}

function performSearch() {
  let q = document.querySelector('#search').value;

  for (const login in account_cache) {
    const account = account_cache[login];
    let matches = execSearch(q, login, account);

    let row = document.getElementById('acc-' + login)
    if (row) {
      row.style.display = matches ? '' : 'none';
    }
  }
}

var update_cycle = -1;
/**
 * Updates all displayed information
 * @param {Boolean} force force update
 */
async function updateAccounts(force = false) {
  clearTimeout(update_cycle);
  tags_cache = await ipcRenderer.invoke('settings:get', 'tags');
  const accounts = await ipcRenderer.invoke('accounts:get');
  let changed = false;
  for (const login in accounts) {
    let row = FindOrCreateRow(login, tr => {
      tr.querySelector('.copy-code').addEventListener('click', e => {
        e.preventDefault();
        clipboard.writeText(friendCode.encode(account_cache[login].steamid), 'clipboard');
        showToast('Code copied to clipboard', 'success');
      });

      tr.querySelector('.copy-passwd').addEventListener('click', e => {
        e.preventDefault();
        clipboard.writeText(account_cache[login].password, 'clipboard');
        showToast('Password copied to clipboard', 'success');
      });

      tr.querySelector('.copy-steamguard').addEventListener('click', async e => {
        e.preventDefault();
        try {
          let code = await ipcRenderer.invoke('steamtotp', { secret: account_cache[login].sharedSecret });
          clipboard.writeText(code, 'clipboard');
          showToast('SteamGuard Code copied to clipboard', 'success');
        }
        catch (e) {
          // The failure (bad/absent shared secret, IPC error) is surfaced to
          // the user as a toast, which is the meaningful handling here; there is
          // no redacting logger in the renderer, so we intentionally do not log
          // the raw error object (it can reference secret-bearing data).
          showToast('An error occured when getting steam guard code', 'danger')
        }
      });
      
      tr.querySelector('.open-pofile').addEventListener('click', e => {
        e.preventDefault();
        shell.openExternal('https://steamcommunity.com/profiles/' + account_cache[login].steamid);
      });

      tr.querySelector('.refresh').addEventListener('click', async e => {
        e.preventDefault();
        let promise = ipcRenderer.invoke('accounts:check', login);
        updateAccounts();
        let ret = await promise;
        if (ret.error) {
          showToast(login + ': ' + ret.error, 'danger');
        }
        updateAccounts();
      });
      
      tr.querySelector('.delete').addEventListener('click', async e => {
        e.preventDefault();
        if (e.ctrlKey) {
          await ipcRenderer.invoke('accounts:delete', login);
          updateAccounts();
          tr.remove();
          document.querySelectorAll('.tooltip').forEach(elem => elem.remove()); //remove all tooltips when ctrl click deleting (I think this will leak memory in bootstrap, oh well, to lazy to do properly)
        } else {
          let modal_div = document.querySelector('#confirmDeleteAccount');
          modal_div.querySelector('input[name=login]').value = login;
          bootstrap.Modal.getInstance(modal_div).show();
        }
      });

      tr.querySelector('.edit').addEventListener('click', async e => {
        e.preventDefault();
        bootstrap.Modal.getInstance(document.querySelector('#editAccountModal')).show(login);
      });
    });

    changed |= updateRow(row, login, accounts[login], force);
  }
  if (changed) {
    performSearch();
    if (LastClickedColumn) {
      handleSort(LastClickedColumn, false);
    }
  }
  update_cycle = setTimeout(updateAccounts, 500);
}

document.addEventListener('DOMContentLoaded', () => {
  // Intentional side-effect instantiation: constructing a bootstrap.Tooltip
  // registers the hover-triggered tooltip on the element and stores the instance
  // internally on Bootstrap's side (retrievable later via
  // bootstrap.Tooltip.getInstance, as done in renderRowRanks). We do not need
  // the returned reference here, so it is deliberately not assigned - removing
  // the `new` would disable tooltips for the static markup.
  document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
    new bootstrap.Tooltip(el, { trigger: 'hover' });
  });

  let deleteConfirmationModal_div = document.querySelector('#confirmDeleteAccount');
  let deleteConfirmationModal = new bootstrap.Modal(deleteConfirmationModal_div);
  deleteConfirmationModal_div.querySelector('button.btn.btn-danger').addEventListener('click', async () => {
    deleteConfirmationModal.hide();
    let login = deleteConfirmationModal_div.querySelector('input[name=login]').value;
    if (login) {
      await ipcRenderer.invoke('accounts:delete', login);
      document.getElementById('acc-' + login).remove();
      updateAccounts();
    }
  });

  let editAccountModal_div = document.querySelector('#editAccountModal');
  let editAccountModal = new bootstrap.Modal(editAccountModal_div);

  editAccountModal_div.addEventListener('show.bs.modal', async e => {
    //hide password and shared secret by default
    editAccountModal_div.querySelectorAll('.showHidePassword input').forEach(elem => elem.setAttribute('type', 'password'));
    editAccountModal_div.querySelectorAll('.showHidePassword i').forEach(elem => elem.innerText = 'visibility_off');

    let title = editAccountModal_div.querySelector('.modal-title');
    let username = editAccountModal_div.querySelector('#user-name');
    let password = editAccountModal_div.querySelector('#user-passwd');
    let secret = editAccountModal_div.querySelector('#user-secret');
    let tags = editAccountModal_div.querySelector('#user-tags');

    await ipcRenderer.invoke('settings:get', 'tags').then(new_tags => {
      while (tags.firstChild) {
        tags.firstChild.remove();
      }

      let def_option = document.createElement('option');
      def_option.value = '-- no tags --';
      def_option.innerText = '-- no tags --';
      tags.appendChild(def_option);

      for (const tag in new_tags) {
        const color = new_tags[tag];
        let option = document.createElement('option');
        option.value = tag;
        option.innerText = tag;
        option.style.color = color;
        tags.appendChild(option);
      }
    });
    tags.querySelectorAll('option').forEach(opt => opt.selected = false);

    if (!e.relatedTarget) {
      title.innerText = 'Add new account';
      username.value = '';
      username.disabled = false;
      password.value = '';
      secret.value = '';
    } else {
      let login = e.relatedTarget;
      let account = account_cache[login];

      title.innerText = 'Edit account';
      username.value = login;
      username.disabled = true;
      password.value = account.password;
      secret.value = account.sharedSecret ?? '';
      (account.tags ?? []).forEach(tag => {
        let opt = tags.querySelector('option[value="' + tag + '"]');
        if (!opt) {
          opt = document.createElement('option');
          opt.value = tag;
          opt.innerText = tag;
          tags.appendChild(opt);
        }
        opt.selected = true;
      });
      if (tags.querySelectorAll('option:checked').length == 0) {
        tags.querySelector('option[value="-- no tags --"]').selected = true;
      }
    }
  });

  document.querySelector('#new-account').addEventListener('click', () => {
    editAccountModal.show();
  });

  document.querySelectorAll('.showHidePassword').forEach(elem => {
    let input = elem.querySelector('input');
    let icon = elem.querySelector('i');
    elem.querySelector('a').addEventListener('click', e => {
      e.preventDefault();
      if (input.getAttribute('type') == 'text') {
        input.setAttribute('type', 'password');
        icon.innerText = 'visibility_off';
      } else {
        input.setAttribute('type', 'text');
        icon.innerText = 'visibility';
      }
    });
  });

  editAccountModal_div.querySelector('button.btn.btn-primary').addEventListener('click', async e => {
    e.preventDefault();
    editAccountModal.hide();

    let username = editAccountModal_div.querySelector('#user-name');
    let password = editAccountModal_div.querySelector('#user-passwd');
    let secret = editAccountModal_div.querySelector('#user-secret');
    let tags = editAccountModal_div.querySelector('#user-tags');
    let tag_values = [...tags.selectedOptions].map(x => x.value).filter(x => x != '-- no tags --');

    if (!username.disabled) { //if login is enabled then we are adding new account
      await ipcRenderer.invoke('accounts:add', username.value, password.value);
      await ipcRenderer.invoke('accounts:update', username.value, {
        tags: tag_values,
        sharedSecret: secret.value.trim().length > 0 ? secret.value : undefined
      });
      let ret = ipcRenderer.invoke('accounts:check', username.value);
      updateAccounts();
      ret = await ret;
      if (ret.error) {
        showToast(username.value + ': ' + ret.error, 'danger');
      }
      updateAccounts();
    } else {
      await ipcRenderer.invoke('accounts:update', username.value, {
        password: password.value,
        tags: tag_values,
        sharedSecret: secret.value.trim().length > 0 ? secret.value : undefined
      });
      updateAccounts();
    }
    let promise = ipcRenderer.invoke('accounts:check', username.value);
    updateAccounts();
    let ret = await promise;
    if (ret.error) {
      showToast(username.value + ': ' + ret.error, 'danger');
    }
    updateAccounts();
  });

  let steamGuardModal_div = document.querySelector('#steamGuardModal');
  let steamGuardModal = new bootstrap.Modal(steamGuardModal_div);

  steamGuardModal_div.addEventListener('show.bs.modal', () => {
    steamGuardModal_div.querySelector('#steam-guard').value = '';
  })

  let code_sent = false;
  // Username the Steam Guard prompt is currently shown for. Echoed back with
  // the response so the main process can match the code to the right account
  // when several accounts are being checked concurrently.
  let steamGuardUsername = null;
  steamGuardModal_div.addEventListener('hide.bs.modal', e => {
    if (!code_sent) {
      ipcRenderer.send('steam:steamguard:response', null, steamGuardUsername);
    }
    code_sent = false;
  })

  steamGuardModal_div.querySelector('button.btn.btn-primary').addEventListener('click', async e => {
    e.preventDefault();
    let code = steamGuardModal_div.querySelector('#steam-guard').value.trim();
    ipcRenderer.send('steam:steamguard:response', code.length == 0 ? null : code, steamGuardUsername);
    code_sent = true;
    steamGuardModal.hide();
  })

  ipcRenderer.on('steam:steamguard', (_, username) => {
    steamGuardUsername = username;
    steamGuardModal_div.querySelector('#steam-guard-username').innerText = username;
    steamGuardModal.show();
  });

  document.querySelector('#import').addEventListener('click', async e => {
    e.preventDefault();
    await ipcRenderer.invoke('accounts:import');
  });

  document.querySelector('#export').addEventListener('click', async e => {
    e.preventDefault();
    await ipcRenderer.invoke('accounts:export');
  });

  ipcRenderer.on('update:available', (_, autoDownload, updateUrl) => {
    if (autoDownload) {
      return showToast('New update available, downloading...', 'success');
    }
    return showToast(`New update available, <br>you can <a href="${updateUrl}" class="text-white" target="_blank" onclick="shell.openExternal(this.href); return false;">download it here</a>`, 'success', true);
  })
  ipcRenderer.on('update:downloaded', _ => {
    showToast('Update downloaded, restart the program to update', 'success');
    document.title += " (Update available)";
  })

  document.querySelector('#reloadall').addEventListener('click', async e => {
    // Route the refresh-all through the main process bounded queue so at most
    // `concurrency` steam-user logons run at once. Per-account results arrive
    // via the 'accounts:updated' IPC event.
    await ipcRenderer.invoke('accounts:check_all');
    updateAccounts();
  });

  let settingsModal_div = document.querySelector('#settingsModal');
  let settingsModal = new bootstrap.Modal(settingsModal_div);
  let setup_encryption_div = settingsModal_div.querySelector("#setup-encryption");

  settingsModal_div.addEventListener('show.bs.modal', async () => {
    let tag_list = settingsModal_div.querySelector('#tag-list');

    [tags_cache, encrypted] = await Promise.all([
      ipcRenderer.invoke('settings:get', 'tags'),
      ipcRenderer.invoke('settings:get', 'encrypted')
    ]);

    while (tag_list.firstChild) {
      tag_list.firstChild.remove();
    }
    for (const tag in tags_cache) {
      tag_list.appendChild(createTagEdit(tag, tags_cache[tag]));
    }

    if (encrypted) {
      setup_encryption_div.classList.add('encrypted');
    }
    else {
      setup_encryption_div.classList.remove('encrypted');
    }
  })

  settingsModal_div.querySelector('#new-tag-btn').addEventListener('click', e => {
    e.preventDefault();
    let new_name = settingsModal_div.querySelector('#new-tag').value.trim();
    if (new_name.length != 0 && document.getElementById('tag-edit-' + new_name) == null) {
      settingsModal_div.querySelector('#tag-list').appendChild(createTagEdit(new_name));
      settingsModal_div.querySelector('#new-tag').value = '';
    }
  })

  settingsModal_div.querySelector('.modal-footer button.btn.btn-primary').addEventListener('click', async e => {
    e.preventDefault();
    let rows = settingsModal_div.querySelectorAll('#tag-list .row');
    let new_tags = Object.fromEntries([...rows].map(x => [x.querySelector('input[type=text]').value, x.querySelector('input[type=color]').value]));

    await ipcRenderer.invoke('settings:set', 'tags', new_tags);
    settingsModal.hide();
    updateAccounts(true);
  })

  document.querySelector('#settings').addEventListener('click', async e => {
    e.preventDefault();
    settingsModal.show();
  });

  document.querySelector('#search').addEventListener('input', () => performSearch());

  document.querySelectorAll('#main-table th.sortable').forEach(e => e.addEventListener('click', e => {
    e.preventDefault();
    handleSort(e.target);
  }));

  document.querySelector('#delete-all-btn').addEventListener('click', async e => {
    await ipcRenderer.invoke('accounts:delete_all');
    document.querySelectorAll('#main-table tbody tr').forEach(row => row.remove());
    updateAccounts();
  });

  document.querySelector('#setup-encryption .btn-success').addEventListener('click', async e => {
    encrypted = await ipcRenderer.invoke('encryption:setup');
    if (encrypted) {
      showToast('Data encrypted successfully', 'success');
    }
    else {
      showToast('Encryption setup canceled', 'danger');
    }
    updateAccounts();
  });

  document.querySelector('#setup-encryption .btn-danger').addEventListener('click', async e => {
    encrypted = await ipcRenderer.invoke('encryption:remove');
    if (!encrypted) {
      showToast('Data decrypted successfully', 'success');
    }
    else {
      showToast('Decryption setup canceled', 'danger');
    }
    updateAccounts();
  });

  let changeLogModal_div = document.querySelector('#changeLogModal');
  let changeLogModal = new bootstrap.Modal(changeLogModal_div);

  ipcRenderer.on('update:changelog', (_, markdown) => {
    if (version) {
      changeLogModal_div.querySelector('.modal-title').innerText = 'Changelog - ' + version;
    }
    changeLogModal_div.querySelector('.modal-body').innerHTML = md_converter.makeHtml(markdown);
    changeLogModal.show();
  });

  // Обработчик обновления данных аккаунта
  ipcRenderer.on('accounts:updated', (_, { login, data }) => {
    console.log(`Получено обновление для аккаунта ${login}:`, data);
    let row = document.getElementById('acc-' + login);
    if (row) {
      updateRow(row, login, data, true);
    }
  });

  updateAccounts();

  ipcRenderer.invoke('ready');

  // Обработчик для кнопки отображения рейтинга по картам
  document.addEventListener('click', function(e) {
    if (e.target.closest('.show-maps')) {
      const row = e.target.closest('tr');
      const username = row.querySelector('.login').textContent;
      
      // Устанавливаем имя пользователя в заголовке модального окна
      document.getElementById('maps-username').textContent = username;
      
      // Получаем данные о картах для этого пользователя
      const account = account_cache[username];
      
      // Очищаем таблицу
      const mapsTableBody = document.querySelector('#maps-table tbody');
      mapsTableBody.innerHTML = '';
      
      // Если у аккаунта есть данные о картах, отображаем их
      if (account && account.maps) {
        // Сортируем карты по количеству побед (по убыванию)
        const sortedMaps = Object.entries(account.maps).sort((a, b) => b[1].wins - a[1].wins);
        
        // Добавляем строки в таблицу
        sortedMaps.forEach(([mapName, mapData]) => {
          const row = document.createElement('tr');
          
          // Форматируем дату последнего матча
          let lastMatch = 'N/A';
          if (mapData.last_match) {
            const date = new Date(mapData.last_match);
            lastMatch = date.toLocaleString();
          }
          
          // Преобразуем название группы навыков в номер ранга
          let rank = 0;
          if (mapData.skill_group) {
            const rankMatch = mapData.skill_group.match(/\d+/);
            if (rankMatch) {
              rank = parseInt(rankMatch[0]);
            }
          }
          
          // Получаем путь к значку карты
          const mapIconPath = getMapIconPath(mapName);
          
          row.innerHTML = `
            <td class="text-center" style="width: 50px;">
              ${mapIconPath ? `<img src="${mapIconPath}" alt="${mapName}" style="max-width: 100%;" onerror="this.style.display='none'">` : ''}
            </td>
            <td class="text-center">${mapName}</td>
            <td class="text-center">${mapData.wins || 0}</td>
            <td class="text-center">${mapData.ties || 0}</td>
            <td class="text-center">${mapData.losses || 0}</td>
            <td class="text-center">
              <img src="${getRankImage(rank, 0, 'mm')}" alt="${mapData.skill_group || 'N/A'}" class="rank-image" style="height: 26px;" 
                   data-bs-toggle="tooltip" data-bs-html="true" 
                   title="${mapData.skill_group || 'N/A'}">
            </td>
            <td class="text-center">${lastMatch}</td>
          `;
          
          mapsTableBody.appendChild(row);
        });
      } else {
        // Если данных нет, показываем сообщение
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="7" class="text-center">No map data available</td>';
        mapsTableBody.appendChild(row);
      }
      
      // Открываем модальное окно
      const mapsModal = new bootstrap.Modal(document.getElementById('mapsRatingModal'));
      mapsModal.show();
    }
  });
})

/**
 * Получает путь к значку карты по её названию
 * @param {String} mapName название карты
 * @returns {String} путь к значку карты
 */
function getMapIconPath(mapName) {
  // Список известных карт и их значков
  const mapIcons = {
    // Официальные карты
    'Ancient': 'de_ancient.svg',
    'Anubis': 'de_anubis.svg',
    'Dust': 'de_dust.svg',
    'Dust 2': 'de_dust2.svg',
    'Dust II': 'de_dust2.svg', // Добавлено для поддержки альтернативного названия
    'Inferno': 'de_inferno.svg',
    'Mirage': 'de_mirage.svg',
    'Nuke': 'de_nuke.svg',
    'Overpass': 'de_overpass.svg',
    'Train': 'de_train.svg',
    'Vertigo': 'de_vertigo.svg',
    'Baggage': 'ar_baggage.svg',
    'Shoots': 'ar_shoots.svg',
    'Italy': 'cs_italy.svg',
    'Office': 'cs_office.svg',
    
    // Сообщества карт
    'Pool Day': 'ar_pool_day.svg',
    'Assembly': 'de_assembly.svg',
    'Basalt': 'de_basalt.svg',
    'Edin': 'de_edin.svg',
    'Memento': 'de_memento.svg',
    'Mills': 'de_mills.svg',
    'Palais': 'de_palais.svg',
    'Thera': 'de_thera.svg',
    'Whistle': 'de_whistle.svg'
  };
  
  // Проверяем, есть ли карта в списке
  if (mapIcons[mapName]) {
    return `img/maps-icons/${mapIcons[mapName]}`;
  }
  
  // Если карта не найдена, пробуем определить по префиксу
  if (mapName.startsWith('de_') || mapName.startsWith('ar_') || mapName.startsWith('cs_')) {
    return `img/maps-icons/${mapName}.svg`;
  }
  
  // Если ничего не найдено, возвращаем пустую строку
  return '';
}

# Second-Pass Deep Technical Audit — csgo-checker

Electron/Node.js CS2 account checker. This is the second, deeper audit after the
prior refactor (showdown -> markdown-it, AES-256-GCM migration, cyclomatic /
file-length refactors, XP-constant false positive, naming, and added
markdown/XSS + XP/GC/rank tests). This report is analysis + documentation only;
no source code was changed in this feature. Every finding is grounded in a
concrete file/line reference.

## Baseline (verified before writing this report)

| Check | Command | Result |
| --- | --- | --- |
| Tests | `npm test` | 133 pass / 0 fail / 0 skipped |
| Lint | `npm run lint` (`eslint .`) | clean, no findings |
| Dependencies | `npm audit` | found 0 vulnerabilities |
| Package | `npm run package` (`electron-builder --dir`) | `dist/linux-unpacked` built (electron 44.1.0); the Windows target fails only for missing wine, which is EXPECTED and NOT a regression |

Environment: Node v22, OPEN_INTERNET, no Dockerfile. Branch:
`feat/port-steam-account-manager-improvements`.

Audit scope covered all 10 requested domains: security (XSS/DOM-XSS/injection/
SSRF), Electron security (main/preload/renderer/IPC/nav guards/webPreferences),
dependencies, error handling, resource leaks, Steam/GC/protobuf validation,
testing, architecture, performance, code quality.

---

## 1. CRITICAL

### C-1. DOM-XSS via attribute breakout in the maps-rating modal (`html/js/front.js`, `.show-maps` handler, ~L1008-1050)

**Sink.** The `.show-maps` click handler (delegated listener registered at
`html/js/front.js` ~L986) builds a table row with `row.innerHTML = \`...\``
(~L1031-1050). Two scraped values are interpolated with NO HTML escaping, both
into text nodes AND into HTML attributes:

```
<img src="${mapIconPath}" alt="${mapName}" ... onerror="this.style.display='none'">
...
<td class="text-center">${mapName}</td>
...
<img src="${getRankImage(rank, 0, 'mm')}" alt="${mapData.skill_group || 'N/A'}"
     class="rank-image" ... data-bs-toggle="tooltip" data-bs-html="true"
     title="${mapData.skill_group || 'N/A'}">
```

**Source.** `mapName` and `mapData.skill_group` originate from
`helpers/gcpd_parser.js` `extractCompetitiveMaps` -> `parseCompetitiveMapRow`
(~L505-560). The map name comes from the regex capture `<td>([^<]+)</td>` and
`skill_group` from `<td>([^<]*)</td>` (see `COMPETITIVE_MAP_ROW_SOURCE`,
~L532). This HTML is external Steam GCPD content fetched over HTTP in
`main.js` `fetchMatchmaking` (`https://steamcommunity.com/profiles/${steamid64}/gcpd/730?tab=matchmaking`)
and stored on `data.maps` via `applyMatchmakingData` (`main.js` ~L1015),
then handed to the renderer through `accounts:updated` / `accounts:get`.

**Exploit shape.** The `[^<]` character class blocks a literal `<`, so a raw
`<script>` tag cannot be injected into the text node. But `[^<]` does NOT block
the double-quote `"` or spaces. A crafted map name or skill-group value such
as:

```
x" onerror="alert(document.domain)
```

closes the `alt="..."` (or `title="..."`) attribute early and injects a new
`onerror`/`onmouseover` event-handler attribute. When the `<img>` fails to load
(and `getMapIconPath` returns an unknown/attacker-influenced path) or the user
hovers, the injected handler executes in the renderer's origin. This is a
genuine, executable DOM-XSS driven by attacker-controlled or MITM/compromised
Steam GCPD data. It is the one genuinely exploitable security defect found.

**Impact assessment (why CRITICAL vs HIGH).** Renderer runs with
`contextIsolation: true` and no `nodeIntegration`, so injected script cannot
directly `require('child_process')`. However the preload `contextBridge`
surface (`preload.js`) exposes `shell.openExternal`, `clipboard.writeText`,
`friendCode.encode`, and a fully variadic `ipcRenderer.send/on/invoke`. Injected
script running in the renderer can therefore invoke privileged IPC channels
(`accounts:export`, `accounts:get`, `settings:set`, `shell.openExternal`) and
exfiltrate/manipulate account data. Arbitrary IPC access from injected script
raises the severity to CRITICAL.

**Intended fix (FEAT-002, not this feature).** Introduce a pure HTML-escape
helper (renderer-side `escapeHtml`, mirroring the existing
`helpers/markdown.js` XSS-safe pattern) and escape `mapName` /
`mapData.skill_group` before interpolation into both the text nodes and the
`alt`/`title` attributes. A regression test IS feasible: add a unit test on the
extracted `escapeHtml` helper (assert `"` -> `&quot;`, `<` -> `&lt;`,
`&` -> `&amp;`) in `test/`, analogous to `test/markdown.test.js`. This is a
pure-function test that needs no GUI harness.

---

## 2. HIGH

### H-1. `showToast()` assigns attacker-influenceable text via `.innerHTML` (`html/js/front.js` L43)

`showToast(text, ...)` does `newToast.querySelector('.toast-body').innerHTML = text;`
(L43). Most callers pass static English strings (safe). But three callers
interpolate dynamic values:

- L629 `showToast(login + ': ' + ret.error, 'danger')`
- L795 `showToast(username.value + ': ' + ret.error, 'danger')`
- L810 `showToast(username.value + ': ' + ret.error, 'danger')`

`login`/`username.value` is user-owned (self-XSS only, low risk), but
`ret.error` is the error string returned from the main process. Tracing
`checkErrorMessage` (`main.js`) and `saveAccountCheckFailure`, `ret.error` can
carry `String(error.message)` from steam-user / axios / GC decode failures.
While current known error strings are static, this is a second `.innerHTML`
sink fed by non-static, partially backend-derived text and should be hardened
to `.textContent` (or escaped) so it can never become an injection vector.
Severity HIGH because the reachable path from external error text is plausible
even though not confirmed exploitable today.

**Intended fix.** Change L43 to `.textContent = text` where callers only pass
plain strings, OR escape at the call sites. Note L862 intentionally passes an
HTML anchor (`New update available, <a href=...>`) to `showToast`, so a blanket
switch to `.textContent` would break that one caller — the fix must preserve
the update-toast HTML (e.g. an explicit `html`-allowed flag or a dedicated
render path) while making the `ret.error` path text-only. Regression test:
feasible against an extracted escaping helper, not against the DOM toast itself
(no GUI harness in sandbox).

---

## 3. MEDIUM

### M-1. `shell.openExternal` exposed to the renderer without a protocol allowlist (`preload.js` L54-56)

`contextBridge.exposeInMainWorld('shell', { openExternal: (url, options) => shell.openExternal(url, options) })`
forwards ANY url/options straight to Electron's `shell.openExternal`. The
`main.js` navigation guards (`setWindowOpenHandler`) DO enforce http/https only
for window-open events, but that guard does not cover direct renderer calls to
`window.shell.openExternal(...)`. The renderer calls it with hard-coded
`https://steamcommunity.com/...` (front.js L621, L654) and via the update-toast
anchor's `onclick` (L862), so today's callers are safe — but combined with C-1
(DOM-XSS) an attacker could call `window.shell.openExternal('file:///...')` or
another scheme. Defense-in-depth: validate the protocol (http/https only)
inside the preload wrapper, mirroring the `main.js` guard. MEDIUM because it is
only weaponizable in conjunction with C-1/H-1.

### M-2. Bootstrap tooltip leak on ctrl-click delete (`html/js/front.js` ~L642)

Self-documented in the code: `document.querySelectorAll('.tooltip').forEach(elem => elem.remove()); //... I think this will leak memory in bootstrap, oh well, to lazy to do properly`.
The tooltip DOM nodes are removed but the associated `bootstrap.Tooltip`
instances are not disposed, so their internal references accumulate over many
delete operations. Real but low-rate leak (only on ctrl-click delete). MEDIUM.
Fix: call `bootstrap.Tooltip.getInstance(el)?.dispose()` before removing the
row's rank images. Hard to regression-test without a GUI harness.

### M-3. 500ms self-rescheduling full-refresh polling loop (`html/js/front.js` L662)

`updateAccounts()` ends with `update_cycle = setTimeout(updateAccounts, 500);`
(L662), so the renderer re-invokes `ipcRenderer.invoke('accounts:get')` +
`settings:get('tags')` and re-renders every row every 500ms indefinitely, even
when nothing changed and even though the main process ALSO pushes granular
`accounts:updated` events (front.js L974). This is redundant polling on top of
an event-driven channel. The per-row diffing via `updateRow`/`fastEqual` limits
DOM churn, so this is a performance/efficiency issue, not a correctness bug.
MEDIUM. Any change here risks the hard-won DOM write-order / rank-render
invariants, so it should be treated cautiously and is arguably acceptable as-is.

---

## 4. LOW

### L-1. Debug `console.log` of account data left in production renderer (`html/js/front.js`)

`renderRowPrime`/`premierExpireSuffix` region logs account internals, e.g.
`console.log('Premier date object for ' + account.name + ':', account.premier_date);`
(~L445) and `console.log('Last game date for ' + account.name ...)` (~L448),
plus `console.log('Получено обновление для аккаунта ${login}:', data)` (L975).
These leak account names / timestamps to the devtools console and are debug
noise. LOW. Removing them is safe but is a behavior-adjacent cleanup.

### L-2. Extensive Russian-language comments and `console.log` strings in an otherwise-English codebase (`html/js/front.js`, `main.js`)

Mixed-language comments (e.g. `// Если у аккаунта есть данные о картах`,
`// Исправление загрузки proto-файлов`) reduce maintainability/consistency but
are harmless. LOW / cosmetic. Not worth churning files solely for this.

### L-3. Magic numbers for GC/timeout constants embedded inline

Timeouts such as the 45s outer timeout (`main.js` ~L1000), the 30s GC-phase
timeout (~L1210), the 5s post-web GC wait (~L1170), and the 500ms poll
(front.js L662) are inline literals. The GC protocol constants are already
named (`GC_HELLO_VERSION`, `GC_HELLO_RETRY_INTERVAL`, `GC_HELLO_MAX_ATTEMPTS`,
`GC_MSG`), which is good; the timeout literals could follow suit. LOW.

---

## 5. FALSE POSITIVE (leave as-is, with reason)

These are items a scanner or a shallow reviewer might flag, but which are
correct/safe by design and must NOT be "fixed" pointlessly (and prior fixes
here must NOT be reverted):

- **Changelog `innerHTML` (`html/js/front.js` L970).** SAFE.
  `changeLogModal_div.querySelector('.modal-body').innerHTML = md_converter.makeHtml(markdown)`
  goes through `helpers/markdown.js`, which configures markdown-it with
  `html: false` (raw HTML in the source is escaped, not emitted). This is the
  intended, XSS-safe replacement for the removed `showdown` dependency. Do not
  revert.

- **Account name / level / XP / ban cells use `innerText`.** SAFE.
  `steam-name` (L332), login (L306), level (L367), exp (L385/389/393), and ban
  (L516/538/540) are written via `.innerText`, which does not parse HTML. These
  are the correct safe sinks for scraped/derived values and are distinct from
  the C-1 `innerHTML` path.

- **No `eval` / `new Function` / string-based `setTimeout`/`setInterval`.**
  CONFIRMED absent. A repo-wide search
  (`eval(|new Function|setTimeout([\"'\`]|setInterval([\"'\`]`, excluding
  `node_modules/` and `dist/`) returned zero matches. All timers pass function
  references, not code strings.

- **`protoDecode` / `protoEncode` are defensive (`helpers/util.js`).** SAFE.
  `protoDecode` (L46+) validates the proto object has `decode`/`toObject`
  functions and that the input is a Buffer/Uint8Array, returning `{}` on bad
  input; `protoEncode` returns `Buffer.alloc(0)` on bad input. Corrupt/empty GC
  payloads degrade gracefully rather than throwing. Do not add redundant
  validation.

- **Navigation guards on all windows (`main.js` `applyNavigationGuards` +
  `wirePromptWindowCommon`).** SAFE. `will-navigate` denies any navigation off
  the currently loaded bundled file; `setWindowOpenHandler` denies all new
  Electron windows and only hands http/https urls to `shell.openExternal`
  (invalid urls and non-http schemes are logged and blocked). These are wired
  onto the main window AND every prompt window (`promptForPassword`,
  `encryption:setup`, `encryption:remove`) via `wirePromptWindowCommon`.

- **`EncryptedStorage` is authenticated AES-256-GCM.** SAFE / do not touch
  crypto. Prior migration to GCM with legacy-CBC read + upgrade-on-save and the
  never-write-on-decrypt-error property is intentional and covered by
  `test/storage.test.js`.

- **`sandbox: false` in `browserWindowOptions` (`main.js`).** INTENTIONAL, not a
  defect. The preload requires Node APIs (`fast-deep-equal`, `csgo-friendcode`,
  `helpers/markdown`), so full renderer sandbox is deliberately off while
  `contextIsolation: true` and no `nodeIntegration` preserve the security
  boundary. Do not "blindly" enable sandbox.

- **`resolveHelloPenaltyReason` mixed return type (`String | 0`) (`main.js`).**
  INTENTIONAL. `0` is the "no penalty" sentinel matched by strict
  `reason === 0` in the renderer's `formatPenalty`; returning `'0'` would break
  the comparison. Documented in-code. Not a bug.

- **The seven `[\s\S]*?` gaps in `COMPETITIVE_MAP_ROW_SOURCE`
  (`helpers/gcpd_parser.js`).** INTENTIONAL / irreducible. Each skips
  intervening cells so the seven captured `<td>` values line up; collapsing
  them would change extraction and break byte-identical behavior (covered by
  `test/gcpd_parser.test.js`). This is a documented, accepted regex-complexity
  finding, not a defect.

- **`dz` rank uses bare `account.wins_dz` while other modes use `?? 0`
  (`html/js/front.js renderRowRanks`, ~L488).** INTENTIONAL hard invariant.
  The image-vs-title asymmetry and DOM write order are load-bearing; keep
  intact.

---

## 6. DEPENDENCY RISKS

- **`npm audit`: 0 vulnerabilities** at time of audit. Confirmed. Do NOT bump
  anything reflexively.

- **electron.** Resolved at `electron@44.1.0` (`npm ls electron`). The historic
  Electron advisory lineage (ASAR integrity bypass, heap-buffer-overflow in
  bundled Chromium, and the older context-isolation bypass classes) are all
  fixed well before 44.x. No vulnerable Electron version is currently resolved.
  Electron 44 also carries the clipboard W3C rearchitecture that the
  `preload.js clipboard.writeText` `.catch()` wrapper already accommodates. No
  action.

- **extract-zip.** NOT present in the resolved dependency tree
  (`npm ls extract-zip` -> empty). The historic `extract-zip` advisory
  (arbitrary file write / zip-slip via crafted archive entry paths in older
  0.x) reached this project only transitively through older Electron packaging
  tooling; the current tree does not resolve any `extract-zip`, so the advisory
  does not apply. No vulnerable version is installed. No action.

- **Overrides in `package.json` (L18-21).** `steam-appticket: ^2.0.1` and
  `adm-zip: ^0.6.0` are pinned via `overrides` to force patched transitive
  versions (adm-zip < 0.5.x had a zip-slip advisory; the override keeps it on a
  fixed line). These are deliberate and correct; keep them.

- **General.** steam-user, protobufjs, axios, markdown-it, simple-json-db,
  csgo-friendcode, electron-updater — all clean under `npm audit`. No pending
  bumps required. Recommendation: keep the `overrides` block and re-run
  `npm audit` on each dependency change; do not auto-update.

---

## 7. SECURITY RISKS

Consolidated view of the attack surface, by external data source:

- **Steam GCPD HTML (HTTP, MITM-able).** Parsed by regex in
  `helpers/gcpd_parser.js`. Feeds the C-1 DOM-XSS (map name, skill_group). Also
  feeds `data.last_game` via a strict timestamp regex (safe) and ranks that
  flow through `mergeGcpdMatchmaking` (gap-filler, never clobbers -1 sentinel).
  The persona-name scrape in `fetchProfileName` (`main.js`) uses `[^<]+` and is
  written to the renderer via `.innerText` (safe sink). **Primary risk: C-1.**

- **GC protobuf messages (WebSocket via steam-user).** Decoded with defensive
  `protoDecode` (returns `{}` on bad input). All GC handlers guard
  `Array.isArray(...)` / null before iterating (`handleClientWelcome`,
  `handleClientGCRankUpdate`, `handlePlayersProfile`). Unknown `msgType` values
  are ignored (no default in `GC_HANDLERS`). Large/absent fields degrade to
  defaults. Low risk.

- **IPC from renderer -> main (`main.js` `ipcMain.handle/on`).** Channels:
  `accounts:add/update/delete/delete_all/get/check/check_all/import/export`,
  `settings:get/set`, `steamtotp`, `encryption:*`, `steam:steamguard:response`,
  `ready`, `app:version`. These trust renderer-supplied keys/values (e.g.
  `accounts:update` copies arbitrary `data[key]` onto the account object;
  `settings:set` writes arbitrary `type`/`value`). In this single-user desktop
  model the renderer is trusted, so this is acceptable — BUT it magnifies the
  impact of C-1 (a DOM-XSS gets full IPC reach). The realistic mitigation is to
  fix C-1/H-1 at the source rather than to add per-channel schema validation
  (which the user explicitly warned against over-validating). `accounts:import`
  reads a user-chosen file path via `dialog.showOpenDialog` (no path traversal:
  the OS picker supplies the path).

- **Outbound HTTP (SSRF surface).** `fetchWithRetry` in `main.js` only ever
  requests hard-coded `https://steamcommunity.com/profiles/${steamid64}/...`
  where `steamid64 = steamClient.steamID.getSteamID64()` (a numeric SteamID from
  the authenticated session, not user free-text). No user-controlled URL
  reaches axios; SSRF risk is negligible.

- **Secrets handling.** Passwords / shared secrets / cookies are redacted by
  the logger; `process.on('unhandledRejection')` routes through the redacting
  logger specifically so secrets on a rejection are stripped. The
  `copy-steamguard` catch intentionally does not log the raw error to avoid
  leaking secret-bearing data (documented, front.js ~L608). Good.

- **Command injection / shell execution.** None. No `child_process`, `exec`,
  `execSync`, or shell string construction anywhere in app code.

---

## 8. TEST COVERAGE

Current suite: 133 tests across 12 files in `test/` (`checker`, `gcpd_parser`
[23 tests], `importParser`, `logger`, `markdown`, `preload`, `protos`, `queue`,
`rankMerge`, `smoke`, `storage`, `xp`). Strong coverage of the pure/helper
layer, including the prior-added markdown/XSS and XP/GC/rank tests.

**Gaps / recommended additions (feasible without Steam credentials or a GUI):**

- **HTML-escaping helper (for C-1 / H-1 fix).** There is currently NO
  `escapeHtml` helper and no test for attribute-safe escaping of scraped map
  data. When FEAT-002 introduces the escape helper, add a unit test asserting
  `"`, `<`, `>`, `&`, `'` are neutralized — modeled on `test/markdown.test.js`.
  This is the single most valuable missing test.

- **`extractCompetitiveMaps` adversarial input.** `test/gcpd_parser.test.js`
  covers normal rows; consider adding a case where a map name / skill_group
  cell contains a `"` (to document that the parser passes quotes through
  unescaped, which is why escaping must happen at the renderer sink).

- **Renderer sinks are inherently untestable here** (no display/GUI harness per
  `context.json`). The right strategy is to keep escaping logic in a pure,
  extracted helper and unit-test that helper, rather than attempting DOM tests.

No test is failing; the suite is green. Do not add tests that require real
Steam credentials or a live GC connection.

---

## 9. REGRESSION RISKS

Hard invariants that any FEAT-002 fix must NOT disturb (from `context.json` and
confirmed in code):

- **Do not revert prior fixes:** showdown -> markdown-it (`html: false`),
  AES-256-GCM migration, cyclomatic/file-length refactors, XP-constant handling,
  `steam_name` -> `steam-name`, README H1 image, unnecessary-block cleanups, and
  the added markdown/XSS + XP/GC/rank tests.

- **Rank state machine:** expired mm/wg/dz rank == 0 with wins >= 10; premier
  `rank_premier === -1`; VAC cascade forces -1 across modes; GCPD gap-filler
  (`mergeGcpdMatchmaking`) never clobbers a -1 sentinel. Preserve exactly.

- **XP math:** `(cur_xp - 327680000) % 5000` lives in one place
  (`helpers/xp.js`); do not duplicate or alter.

- **GC message-ID/field semantics:** `GC_MSG` IDs, the `resolveHello*`
  sentinels, and `applyGcRanking`/`applyGcRankUpdateEntry` unconditional
  assignment on entry-present (expired rank arrives as `rank_id === 0`) must
  stay byte-for-behavior identical.

- **front.js `renderRowRanks` asymmetry:** `wins_dz` bare vs `?? 0` elsewhere,
  the `wins < 0 ? '?'` mm title guard, and the DOM write order are load-bearing.

- **C-1 fix specifically:** escaping `mapName`/`skill_group` MUST NOT change the
  displayed text for legitimate map names (which contain no HTML metacharacters)
  — escaping is a no-op on `Mirage`, `Dust II`, etc., so the visible modal is
  unchanged. `getMapIconPath` matching (which keys off the raw, unescaped
  `mapName`) must run on the raw value BEFORE escaping, or icons for names with
  metacharacters would break; since legitimate names have none, this is safe,
  but the fix must escape only at the interpolation boundary, not mutate the
  lookup key.

- **H-1 fix specifically:** the update-available toast at front.js L862
  legitimately passes an HTML `<a>` anchor to `showToast`; a blanket
  `.innerHTML` -> `.textContent` switch would break that link. The fix must keep
  the update toast rendering HTML while making the `ret.error` paths text-safe.

- **Verification gate:** nothing is "fixed" until `npm test` (>= 133 pass, 0
  fail), `npm run lint` (clean), `npm audit` (0 vulns), and `npm run package`
  (linux-unpacked builds; wine/Windows failure expected) all pass. Renderer
  changes are verified via `node --check` + eslint + extracted-pure-helper unit
  tests, not runtime UI.

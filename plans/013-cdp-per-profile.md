# Plan 013 — Per-Profile Custom CDP Endpoint

**Date:** 2026-09-03
**Status:** Done
**Scope:** Profiles/accounts → custom CDP URL per profile, live up/down status, used for downloads & collection crawls.
**Owner:** xdl — `scan-videos/browser.js`, `scan-videos/config.js`, `api-server.js`, `web/src/views/Profiles.jsx` (+ Dashboard/Saved consumers)

---

## 1. Goal

Allow each **profile** (account) to optionally point at an **external Chromium via CDP** (`ws://…` or `http://…:9222`) instead of the local CloakBrowser launch.

- **Configure** a custom CDP URL inside the Profiles section (create + edit).
- **Show status** right there — up / down / checking / not configured — with manual re-check and periodic refresh.
- **Use it** when that profile is selected for a download (Dashboard queue) or a collection crawl (Saved / background sync). If the CDP is down the job should surface the error instead of silently falling back to a local launch.

Out of scope: global `CDP_URL` env override, auth headers/tokens for remote CDP, sharing one CDP across many profiles at the storage level (user can paste same URL twice — just data, not a linked resource).

---

## 2. Probe findings (current state)

| Area | Current |
|---|---|
| **Account storage** | `.saved-sync-state.json` → `config.accounts[]` each `{ name, userDataDir, profileDir }`. `config.js:110` `resolveAccountConfig()` merges with defaults from `resolveProfileConfig()` (env `BROWSER_USER_DATA_DIR` / `BROWSER_PROFILE_DIR`). No CDP field. |
| **Browser launch** | `scan-videos/browser.js:55` `launchBrowser()` always calls `cloakbrowser/puppeteer` `launchPersistentContext({ headless, args, userDataDir })` with lock-clone fallback. `buildBrowserFromLocalProfile({ account })` resolves the account config then calls `launchBrowser`. No `puppeteer.connect()` path. |
| **Browser lifecycle (api-server.js)** | `browsersByAccount: Map<string, Browser>` for crawl/download reuse (`getBrowserForAccount`, `closeBrowserForAccount`), `sharedBrowser` for `default`, `manualBrowsersByAccount` for visible VNC `POST /open-browser` flow. `browserIsAlive()` polls `isConnected()` + pid. `getSharedBrowser()` / `getBrowserForAccount()` are the two entry points used by `POST /download`, `POST /scan-saved`, and `queueWorkerLoop`. Background sync (`backgroundSyncTick:1935`) also calls `getBrowserForAccount`. |
| **Profiles API** | `GET /accounts` returns per-account `{ name, userDataDir, profileDir, manualOpen, sharedOpen, accountBrowserOpen }` (923). `POST /accounts` creates, `DELETE /accounts/:name` deletes, `POST /accounts/default/reset` resets default. No update endpoint; Saved uses `POST /sync-config` with full `accounts` array to mutate lists, but Profiles UI only creates. |
| **Profiles UI** | `web/src/views/Profiles.jsx:1` — create form (`name`, `profileDir`), account cards with path + open/closed badge, Open/Close buttons that also drive VNC auto-start, Reset/Delete. Polls `GET /accounts` every 4s + `GET /vnc/status` every 5s. No CDP UI. |
| **Queue/collections usage** | `web/src/views/Dashboard.jsx` `account` select comes from `GET /accounts`; `QueueContext add()` posts `POST /queue/add { urls, folder, maxQuality, account }`; server `queueWorkerLoop` picks `queueAccount` per item and does `getBrowserForAccount` vs `getSharedBrowser`. `Saved.jsx` each savedList has `account`; crawl does `POST /scan-saved { url, account }`, server picks browser the same way. |

---

## 3. Requirements (inferred + explicit)

1. **Per-profile field** `cdpUrl` (string, optional, empty = local launch). Persisted alongside `userDataDir`/`profileDir`.
2. **Status** visible in Profiles: not configured / checking / up / down (+ last check time + error excerpt when down).
3. **Health check** never blocks page load — fast timeout, cached, refreshable. Should work for both `ws://…` and `http://…` forms.
4. **Create + edit** — not just create. User must be able to set, change, clear the CDP URL for existing profiles (including `default`).
5. **Usage** — if an account has `cdpUrl`, every browser acquisition for that account (`queueWorkerLoop`, `POST /download`, `POST /scan-saved`, `POST /open-browser`, `backgroundSyncTick`) prefers CDP:
   - try `connect`; if it fails, job fails with a clear "CDP unreachable: …" message (no silent fallback to local unless explicitly opted-in).
6. **Lifecycle** — CDP browsers are `connect`ed not launched: `browser.disconnect()` on release, not `browser.close()` (which would kill the remote). In-flight maps need a `connectedViaCdp` flag so close helpers branch correctly. VNC is irrelevant for CDP profiles (hide/disable Open-in-VNC when `cdpUrl` is set, or make Open do a health check only).
7. **Validation** — accept `ws://`, `wss://`, `http://`, `https://`; `http(s)` is resolved to its WebSocket endpoint via `GET <http>/json/version` → `webSocketDebuggerUrl` (standard CDP). Trim, length cap, URL parse check.

---

## 4. Design

### 4.1 Data model

```json
// .saved-sync-state.json
{
  "config": {
    "accounts": [
      { "name": "insta_main", "userDataDir": "/data/browser/account-insta_main", "profileDir": "Default", "cdpUrl": "ws://10.69.1.42:9222" },
      { "name": "default",    "userDataDir": "", "profileDir": "Default", "cdpUrl": "" }
    ]
  }
}
```

- New optional string `cdpUrl`. Empty/absent = legacy behavior.
- `resolveAccountConfig(name, accounts)` returns `{ userDataDir, profileDir, cdpUrl }` (trimmed, or `""`).
- `normalizeAccountsInput()` (api-server.js, used by `POST /sync-config`) preserves & sanitizes `cdpUrl` through the same path so Saves editing doesn't wipe it.
- Migration: zero — readers default to `""`.

### 4.2 Backend

#### `scan-videos/config.js`

- `resolveAccountConfig` → include `cdpUrl`.
- Helper `normalizeCdpUrl(raw)` → `""` or trimmed validated URL (`ws/wss/http/https`, `new URL()` parse, max 500 chars).
- Helper `isCdpUrl(v)` for validators.

#### `scan-videos/browser.js`

New helpers, minimal change to existing launch path:

```js
async function resolveCdpWsEndpoint(cdpUrl) {
  // if ws/wss → return as-is
  // if http/https → fetch(`${origin}/json/version`, { signal: timeout 4000 })
  //                 → json.webSocketDebuggerUrl (fallback: `${origin}/json/version` probe then `/json`)
  // throws with message on failure
}

async function connectToCdp(cdpUrl, { log } = {}) {
  const { default: puppeteerCore } = await import("puppeteer-core"); // or cloakbrowser/puppeteer if it exposes connect
  const wsEndpoint = await resolveCdpWsEndpoint(cdpUrl);
  const browser = await puppeteerCore.connect({ browserWSEndpoint: wsEndpoint });
  browser.__cdpUrl = cdpUrl;
  browser.__wsEndpoint = wsEndpoint;
  browser.__isCdp = true;
  return browser;
}

async function buildBrowserFromLocalProfile(options = {}) {
  // if options.account has cdpUrl (via resolveAccountConfig) OR options.cdpUrl passed directly:
  //   try connectToCdp(); on failure throw ApiError-like error with status 502 / message "CDP unreachable …"
  // else: existing launchBrowser(...) path
}
```

- `launchBrowser` stays untouched for the non-CDP branch.
- `connectToCdp` uses a short connect timeout (e.g. 8s) and surfaces the fetch/ws error.
- Export `resolveCdpWsEndpoint`, `connectToCdp`, `checkCdpStatus(cdpUrl)` (thin wrapper over `resolveCdpWsEndpoint` + `fetch` probe that returns `{ ok, wsEndpoint?, error?, latencyMs }`).

#### `api-server.js`

1. **Status probing**
   - `cdpStatusCache: Map<accountName, { status: 'up'|'down'|'checking'|'not_configured', wsEndpoint, error, latencyMs, checkedAt }>` in-memory.
   - `async function getCdpStatusForAccount(accountName, { force = false } = {})` — returns cached if fresh (<15s and not force), otherwise probes via `checkCdpStatus(cdpUrl)` with 4s HTTP timeout.
   - `GET /accounts` now includes per-account `cdpUrl` + `cdpStatus` (+ `cdpCheckedAt`, `cdpError`, `cdpWsEndpoint`) — but it **does not** block on live probes for every account on every poll: it returns cached and kicks a background refresh if stale. First request after boot triggers async refresh.
   - New `POST /accounts/:name/cdp/check` → force probe, returns `{ ok, status, wsEndpoint, error, latencyMs }` and updates cache. Used by UI Test/Refresh button.
   - Optional `GET /accounts/:name/cdp/status` alias.

2. **Account CRUD**
   - `POST /accounts` accepts optional `cdpUrl`; normalizes, validates (`400` on bad URL), stores.
   - New `PUT /accounts/:name` (or `PATCH`) to update `{ userDataDir?, profileDir?, cdpUrl? }`. Validates, writes via `readStateFile`/`writeStateFile`, clears cache for that account, closes any existing `browsersByAccount` entry if `cdpUrl` changed (so next job reconnects). `default` allowed to set `cdpUrl`.
   - `normalizeAccountsInput` updated to carry `cdpUrl` through `POST /sync-config` so Dashboard/Saved bulk saves don't drop it.

3. **Browser lifecycle branching**
   - Tag CDP browsers (`browser.__isCdp = true`).
   - `closeBrowserForAccount(name, expected)` → if `browser.__isCdp` then `await browser.disconnect().catch(()=>{})` instead of `close()`. Same for `closeAllAccountBrowsers`, shutdown handler, and manual close path.
   - `getBrowserForAccount(name, jobId)` / `getSharedBrowser()` → if `config.cdpUrl` present, call `connectToCdp` path; on `isConnected()==false` re-probe before reuse; on connect failure throw with code `CDP_UNREACHABLE` so callers can surface it.
   - `browserIsAlive` already handles `isConnected`; keep as-is.
    - `POST /open-browser` for a CDP account: reject with `400 { error: "CDP profiles have no VNC — use Test/Check" }` or simply probe `getCdpStatusForAccount(..., {force:true})` and return `{ ok, cdpStatus }`. No VNC session is started; CDP has no VNC desktop.

4. **Job error surfacing**
   - `queueWorkerLoop`, `POST /download`, `POST /scan-saved`, `backgroundSyncTick` currently do `getBrowserForAccount` then `run()`/`scanSavedPage()`. If `getBrowserForAccount` throws CDP-unreachable, the job's `error` becomes `"CDP unreachable for \"<account>\" (ws://…): <reason>"`. No silent fallback. If later we want a toggle, add `cdpFallback: true` per account — not in v1.
   - `runWithJobTimeout` recycle: for CDP browsers, recycling means `disconnect`, not `close`.

5. **Health broadcast**
   - WS `health` already broadcasts `browserReady`; extend to include per-account `cdpReady` counts or at least not break. Optional `type: "cdp:status"` broadcast when a forced check completes.

**CDP URL forms accepted**

- `ws://host:9222` or `ws://host:9222/devtools/browser/<id>` — use directly.
- `wss://…` — same.
- `http://host:9222` or `https://host:9222` — probe `GET http://host:9222/json/version` (timeout 4s) → `webSocketDebuggerUrl`. If that fails but `/json` succeeds, pick first `webSocketDebuggerUrl` in array. Failure → `down`.

### 4.3 Frontend — `web/src/views/Profiles.jsx`

**State added**
- Per-account `cdpUrl` draft + `cdpStatus` from `GET /accounts`.
- `editingCdp: Record<name, string | null>` (null = not editing, string = draft).
- `checking: Set<name>` for spinner on Test/Refresh.

**Account cards — new row under the path line**

- Line 2 currently: `userDataDir/profileDir` mono. Add line 3: `CDP: <mono url or "— not configured">` + status badge:
  - `not_configured` → gray `—`
  - `checking` → amber `Checking…` spinner
  - `up` → green `● CDP up` (+ latency `· 42ms` if present, tooltip shows `wsEndpoint`)
  - `down` → red `● CDP down` (+ `error` truncated, tooltip full)
- Actions in card footer:
  - `Edit CDP` button → inline input (`type=url`, placeholder `ws://host:9222 or http://host:9222`) + Save / Cancel. Save does `PUT /accounts/:name { cdpUrl }`.
  - `Test` button (visible when `cdpUrl` present) → `POST /accounts/:name/cdp/check`, shows spinner, then toast + card badge updates on next `GET /accounts` poll.
  - **No VNC / no Reset for CDP** — when `cdpUrl` present, hide both VNC controls (`Open`, `Close window`, remote-desktop badge) **and** `Reset`. CDP entries show only **Remove** (delete) — even for `default` if it were CDP-typed (no Reset for any CDP). Local entries keep existing: `default` → `Reset`, others → `Delete`, plus VNC `Open`/`Close`.

**Create flow — `http://10.69.1.164:6767/profiles` type selector**

Current: `Create` button toggles a single form (`name` + `profileDir`). New:

1. Click **Create** → show **type selector** (two options, side-by-side cards / radio):
   - **① Local browser** (default) — "The default ones that we have" — uses the local CloakBrowser profile (`userDataDir` + `profileDir`). Icon `bi-laptop` / `bi-hdd`, label `Local` + hint `Stored profile on this server`.
   - **② External CDP** — external Chromium via CDP. Icon `bi-broadcast` / `bi-link-45deg`, label `CDP` + hint `Connect to ws:// or http://host:9222`.

2. Selecting a type reveals the matching form fields:
   - **Local** → `Account name` + `Profile folder` (existing). `POST /accounts { name, profileDir }` (no `cdpUrl`).
   - **CDP** → `Account name` + `CDP URL` (`type=url`, placeholder `ws://10.69.1.42:9222 or http://10.69.1.42:9222`, required). Optional `Profile folder` hidden (not needed). `POST /accounts { name, cdpUrl }` (with `profileDir` defaulting to `Default` server-side, unused). Helper text: "External Chromium — paste the CDP endpoint. Status will show up/down in the profile card."

3. Save does `POST /accounts` with the visible branch's payload; validation errors show inline (bad URL → `400`). After save, auto-probe the new `cdpUrl` (800ms) so the new card's badge flips from `checking` without manual Test.

Implementation detail in `Profiles.jsx`: new state `createType: 'local' | 'cdp'` (default `'local'`), `cdpUrlDraft`, switching type preserves `name` but clears the other branch's field. Toggle UI uses the same bordered card style as the account cards for visual consistency. Existing `showCreate` boolean becomes `{ open: boolean, type: 'local'|'cdp' }` or two separate states.

**Polling**
- Keep 4s `GET /accounts` poll; it now carries `cdpStatus` (cached, cheap). No extra polling loop.
- `Test` forces a live probe; also auto-probe 800ms after saving a `cdpUrl`.

**Future reuse** — no changes needed in `Dashboard.jsx`/`Saved.jsx` beyond the fact that the `account` select already sends `account`; server-side routing does the rest. Optionally show a tiny `CDP` pill next to the account name in those selects when `cdpStatus.up` (follow-up).

### 4.4 `web/src/views/Saved.jsx` & `Dashboard.jsx` — no code required for v1

- They already pass `account` through. Server picks the right browser. Status visibility is centralized in Profiles.

---

## 5. File change list

| File | Change |
|---|---|
| `scan-videos/config.js` | Extend `resolveAccountConfig`, add `normalizeCdpUrl`/`isCdpUrl`, update `loadAppConfig` docs |
| `scan-videos/browser.js` | Add `resolveCdpWsEndpoint`, `connectToCdp`, `checkCdpStatus`, branch `buildBrowserFromLocalProfile` on `cdpUrl`; tag `__isCdp` |
| `api-server.js` | `cdpStatusCache`, `getCdpStatusForAccount`, `GET /accounts` shape, `POST /accounts` cdpUrl, new `PUT /accounts/:name` + `POST /accounts/:name/cdp/check`, lifecycle `disconnect` vs `close`, queue/scan/download/backgroundSync error messages, keep `normalizeAccountsInput` |
| `web/src/views/Profiles.jsx` | Create field, edit row, status badge, Test/Check buttons, VNC button suppression for CDP accounts |
| `web/package.json` | No new deps (uses existing `puppeteer-core`; `fetch` is built-in) |
| `plans/013-cdp-per-profile.md` | This plan |

No changes to `index.html` legacy, `scan-videos/index.js` (browser injected), `scan-videos/scan-saved.js`, `Dockerfile`, `.saved-sync-state.json` shape beyond new optional field.

---

## 6. Edge cases & error handling

- **Bad URL** on save → `400 { ok:false, error:"CDP URL must be ws://, wss://, http:// or https:// …" }`, UI shows inline error.
- **http probe timeout / 4xx** → `down` with `error: "probe …/json/version failed: timeout"`; next job will also fail fast with the same message, not hang.
- **CDP up but browser closed remote** → `isConnected()==false` triggers disconnect + next job re-connects (fresh probe). `closeBrowserForAccount` disconnects stale entry first.
- **Account deleted while CDP connected** → `DELETE /accounts/:name` already calls `closeBrowserForAccount` — now it will `disconnect`.
- **Default account with CDP** → `getSharedBrowser` also checks `resolveAccountConfig("default").cdpUrl`; if set, it connects instead of launching.
- **Mixed local + CDP accounts** → no cross-contamination; `browsersByAccount` keyed by name, each entry tagged.
- **Security** — no secret in URL for v1; if user pastes creds in query, they end up in `.saved-sync-state.json` (file is gitignored). Document as-is.

---

## 7. Alternatives considered

- **Global env `CDP_URL`** — simpler code but doesn't satisfy per-profile requirement; also lost after container restart unless `.env` edited. Rejected; per-profile storage is durable and auditable via UI.
- **Always fallback to local on CDP down** — hides misconfig, burns through local profile state and confuses debugging. Rejected for v1; explicit failure is clearer. Could add a per-account `cdpFallback` boolean later.
- **Server pushes live CDP probes every 4s** — wasteful and slow (each probe is a network round-trip). Instead, `GET /accounts` serves cached status + background refresh; only explicit Test/check forces a live probe.

---

## 8. Implementation steps (order)

1. **Config** — `scan-videos/config.js`: add `normalizeCdpUrl`, extend `resolveAccountConfig`, update `loadAppConfig` shape notes. `node --check`.
2. **Browser** — `scan-videos/browser.js`: add `resolveCdpWsEndpoint` (http→ws), `connectToCdp` (`puppeteer-core.connect` import with `cloakbrowser` fallback), `checkCdpStatus`, branch `buildBrowserFromLocalProfile`. Tag `__isCdp`. `node --check`.
3. **API — status cache + probes** — `api-server.js`: `cdpStatusCache`, `getCdpStatusForAccount`, `checkCdpStatus` re-export. Add `GET /accounts` cdp fields (cached) + `POST /accounts/:name/cdp/check`. Smoke: `curl` probes for ws and http forms, timeout case.
4. **API — CRUD** — extend `POST /accounts` + new `PUT /accounts/:name` (or `PATCH`), update `normalizeAccountsInput`, lifecycle `disconnect` branching in `closeBrowserForAccount`/`getBrowserForAccount`/`getSharedBrowser`/`POST /open-browser`. `node --check api-server.js`.
5. **Web — Profiles** — `web/src/views/Profiles.jsx`: create CDP input, card CDP line + status badge, inline edit + Test button, VNC suppression for CDP. Keep poll interval. `cd web && npm run build`.
6. **Verification** (§9) — manual + `curl` checks, Docker `npm run api` smoke.
7. **Docs** — update `AGENTS.md` module map for `config.js`/`browser.js`, note new endpoints in the table; update `PLAN.md` §5 if desired.

---

## 9. Verification

```bash
node --check scan-videos/config.js
node --check scan-videos/browser.js
node --check api-server.js
cd web && npm run build
```

- `curl -s http://localhost:6767/accounts | jq '.accounts[] | {name, cdpUrl, cdpStatus}'` — after boot, CDP-less accounts show `not_configured`; after adding `ws://host:9222`, status becomes `up` or `down` within one poll cycle.
- **Create** with `POST /accounts { name:"ext", cdpUrl:"ws://…" }` → appears in `GET /accounts`; card shows CDP line + badge (hard refresh after web build).
- **Test** button → `POST /accounts/ext/cdp/check` returns live probe; badge flips in <1s; stopping remote CDP and re-testing flips to `down` with error excerpt.
- **Edit** → `PUT /accounts/ext { cdpUrl:"http://host:9222" }` → http→ws resolution works; status shows `up` + `wsEndpoint`.
- **Bad URL** → `400` + inline UI error.
- **Queue uses CDP** — add a Dashboard download with profile `ext` while remote CDP is up → job succeeds using remote browser (check server log `[browser:ext] connected via CDP …`). Stop remote → same item retried → job fails with `CDP unreachable for "ext" …`, visible in `completed` card error.
- **Collection uses CDP** — collection with `account: ext`, hit Crawl → uses CDP; background sync also respects it (check `[sync] scanning … (account:ext)` log).
- **Card actions** — Local: `default` → `Open`/`Close` VNC + `Reset`; others → `Open`/`Close` VNC + `Delete`. CDP: **only `Remove`** (no VNC, no `Reset` — including for `default` if CDP-typed).
- **Default** — setting `cdpUrl` on `default` makes shared downloads use CDP too; clearing it reverts to local launch.

---

## 10. Risks & mitigations

- `puppeteer-core.connect` vs `cloakbrowser/puppeteer` API mismatch → import both, try `cloakbrowser` first then fall back to `puppeteer-core`; guard with `try/catch` and clear error message.
- http→ws fetch needs no extra deps (Node 18+ `fetch`); add 4s `AbortSignal.timeout` so a dead host doesn't hang `GET /accounts`.
- `browser.disconnect()` leaves remote alive — correct for CDP; don't call `close()` on CDP browsers or you kill the user's external Chrome.
- `GET /accounts` poll now does lightweight cache reads only; live probes only on force-check or stale (15s) background refresh — keeps polling cheap.

---

## 11. Change log

- 2026-09-03: Initial draft — per-profile `cdpUrl`, cached up/down status in Profiles, CDP connect path in browser, `PUT` + `check` endpoints, disconnect lifecycle, no silent fallback.
- 2026-09-03: Clarified create flow for `/profiles` — **Create → type selector** (`Local` vs `CDP`) with branch-specific form fields (local: `name`+`profileDir`; CDP: `name`+`cdpUrl`), per user request for `http://10.69.1.164:6767/profiles`.

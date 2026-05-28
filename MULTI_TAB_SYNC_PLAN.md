# Multi-tab sync rework — work plan

**Status:** draft, awaiting user review before any code changes.
**Scope:** when several tabs open the same worktree, comments / drafts / approvals must stay in sync without clobbering each other.
**This file is temporary.** Delete once the work is reviewed and merged.

---

## Background — failure modes in current code

1. **Concurrent-edit clobber.** `POST /api/state` writes a tab's full in-memory snapshot. Two tabs editing different things within the 500 ms debounce window will overwrite each other (the `hasPendingSave()` guard in `syncFromRemote` actually makes this worse — it shields the stale writer from seeing the fresh data before it flushes).
2. **Open-form clobber.** When a remote update arrives, `syncFromRemote` calls `renderTabs() + initPatchNodes()`, which rebuilds the DOM. Any open comment form / focused textarea is destroyed; in-flight keystrokes that haven't yet hit the debounce are lost.
3. **Cross-browser blindness.** `BroadcastChannel` is same-browser only. Two windows on different browsers (or one on the desktop app + one in a real browser) won't sync until manual reload.

---

## Non-breaking guarantees applied to every task

Each task lands behind these guards so existing flows keep working:

- **Atomic writes**: every server mutation writes to `<file>.tmp` then renames, so a crashed write never leaves a half-file.
- **Per-worktree async mutex**: serialises overlapping reads-modify-writes within a process. Covers both new delta endpoints and the existing bulk `POST /api/state`.
- **Unknown-kind fallback**: any client-side delta applier that doesn't recognise a `kind` falls back to the existing full-`syncFromRemote` path. Worst case = today's behaviour.
- **`flushSave()` stays**: only drafts remain debounced after Task 1, so the flush-before-reload guarantee is narrower but still needed.
- **Submit-reset path untouched**: the bulk `POST /api/state` is kept exclusively for `submitReview` clearing comments/drafts in one shot.

---

## Task list

Status legend: `[ ] todo`  `[~] in progress`  `[x] done`  `[!] needs user input`

Ordering: 1a → 1b → 2 → 3a → 3b → 4. Earlier tasks are landable alone; later ones depend on listed predecessors.

---

### Task 1a — Server delta endpoints (dead code) [x]
**Goal:** add the new write paths in `src/server.js` with full test coverage, but **don't wire any client to them yet**. This task cannot change runtime behaviour because nothing calls the new endpoints.

**Server (`src/server.js`)**
- Per-worktree async mutex.
- Atomic writer helper (tmp + rename).
- New endpoints:
  - `POST /api/state/comment` — `{patchHash, file, key, comment | null}` (null = delete)
  - `POST /api/state/general-comment` — `{patchHash, text}`
  - `POST /api/state/draft` — `{key, text | null}`
  - `POST /api/state/decision` — `{patchHash, kind: 'approve' | 'deny' | 'clear'}`
- Existing `POST /api/state` migrates internally to use the same mutex + atomic writer so the two paths can't race.

**Tests** (`test/server.test.js`)
- Each endpoint round-trips.
- Parallel POSTs on different keys both persist.
- Parallel POSTs on the same key — last write wins, file stays valid JSON.
- Mixed parallel: legacy bulk `POST /api/state` + delta POST in flight at the same time, no corruption.

**Risk:** none for users — endpoints are unused. Pure additive change.

**Status notes:**
- 2026-05-27 — landed. Mutex + atomic writer in `src/server.js`; four delta endpoints; bulk `POST /api/state` migrated to share the lock. 11 new integration tests, all green; full suite 509/509.

---

### Task 1b — Client switches to delta POSTs [x]
**Goal:** stop the concurrent-edit clobber by using the endpoints from Task 1a. Depends on 1a.

**Client (`public/persistence.js`, `public/renderer.js`)**
- Replace each `scheduleAutoSave()` callsite with a targeted delta POST:
  - Comment save / delete → immediate POST `/api/state/comment`.
  - Draft input → 500 ms debounced single-draft POST `/api/state/draft`.
  - Approve / deny / clear → immediate POST `/api/state/decision`.
  - General-comment edits → debounced single POST `/api/state/general-comment`.
- After a successful delta, broadcast on the existing `BroadcastChannel` (still ping-only at this stage; Task 2 upgrades the payload).
- `flushSave()` narrows to "flush pending draft / general-comment debounce" — keep, don't delete.

**Tests** (`test/ui.test.js`)
- Two tabs save comments on different lines within ~100 ms; after reload of a third tab, both comments are present (regression for current clobber).
- Existing single-tab tests for save/delete/approve/deny/draft still pass.
- Submit-reset path (bulk POST) still clears drafts and comments.

**Risk:** medium — this is the behaviour switch. Mitigated by 1a's test coverage and by keeping the bulk `POST /api/state` path for reset.

**Status notes:**
- 2026-05-27 — landed. `persistence.js` rewritten around per-field save functions backed by a `makeDebouncedSaver(url, buildBody)` helper. `revisions.js`/`renderer.js`/`app.js` callsites migrated; submit flow uses `cancelPendingSaves` + `saveStateBulk`. Added `POST /api/state/revisions` server endpoint (load-time migration). New UI regression: two tabs saving on different lines simultaneously, both survive. `current-prompt-bar` describe now calls `resetSharedState` (was implicitly relying on debounce skipping the disk write). Suite 510/510 green.

---

### Task 2 — Targeted DOM application [x]
**Goal:** stop the open-form clobber. Depends on 1b.

**Transport tweak**
- `BroadcastChannel` message carries the delta `{kind, patchHash, file, key, value, originTabId}` instead of a generic "state-updated" ping.

**Client (`public/app.js`)**
- New `applyRemoteDelta(delta)`:
  - `comment` → re-render only that line's display row.
  - `draft` → re-render only that draft row; **skip** if the matching textarea is currently focused or dirty.
  - `decision` → update only the patch's approve/deny pills + submit-button enabled state.
  - `general-comment` → patch the textarea only if not focused; otherwise show a small "changed elsewhere" hint.
  - **Unknown kind** → fall back to today's full `syncFromRemote()`.
- Remove the wholesale `renderTabs() + initPatchNodes()` from `syncFromRemote` for the known-kind path.

**Tests**
- Tab B mid-typing on line L1, tab A saves on line L2 → B's textarea content and focus preserved.
- Tab B has an unfocused draft on line L, tab A saves a real comment on L → B's draft row replaced cleanly by the saved-comment row.
- Tab B has a focused general-comment textarea, tab A edits the same general comment → B's typing preserved; hint shown.

**Risk:** low — fallback ensures we never do worse than today.

**Status notes:**
- 2026-05-27 — landed. `BroadcastChannel` payload now carries `{type:'delta', delta}` (bulk saves use `{kind:'bulk'}`). `applyRemoteDelta` in `app.js` dispatches to targeted handlers for comment / draft / decision / general-comment; unknown kinds and bulk/revisions fall back to `fullRefresh()`. Open comment forms, focused general-comment textareas, and open commit-message forms are all skipped. Approve/deny also re-renders the patch's commit-message block so its disabled-closure stays consistent. Four new UI tests: cross-tab approve, same-line open form preserved, different-line open form preserved, focused GC textarea preserved. Suite 514/514 green.

---

### Task 3a — SSE endpoint added alongside BroadcastChannel [x]
**Goal:** make cross-browser / cross-window sync possible. Depends on Task 2. BroadcastChannel stays as primary; SSE runs in parallel and is the only path used when BC isn't available.

**Server**
- `GET /api/state/events` SSE stream.
- Each delta handler pushes `{kind, key, value, version, originTabId}` to all SSE listeners **and** the existing BroadcastChannel-trigger path is untouched.
- In-memory monotonic `version` per worktree, persisted alongside state.
- Connection lifecycle: tear down on `req.close`, on worktree switch, on server shutdown. No leaks.

**Client**
- Open an `EventSource('/api/state/events')` in addition to `BroadcastChannel`.
- Both deliver to the same `applyRemoteDelta`; de-dupe by `{originTabId, version}` so we don't apply the same delta twice.
- Ignore events where `originTabId === TAB_ID`.

**Tests**
- Server unit: two SSE listeners, fire a delta, both receive the same payload + version. Connections cleaned up on disconnect.
- Playwright: two separate `browser.newContext()` instances; save in A, observe in B without reload (proves the SSE path works on its own).
- Existing same-context Playwright tests still pass (proves BroadcastChannel path still works).

**Risk:** low — SSE is additive. If it fails silently, BroadcastChannel still covers the common case.

**Status notes:**
- 2026-05-27 — landed. `GET /api/state/events` SSE stream with per-worktree subscriber filtering and per-connection cleanup on `req.close`. Every write endpoint calls `publishStateEvent(delta, req)` which carries `_from`/`_seq` from the request's `X-Tab-Id`/`X-Tab-Seq` headers plus an in-process `_version`. Client `initStateChannel` opens an `EventSource` alongside the existing `BroadcastChannel`; both feed `makeReceiver(...)` which dedupes by `(_from, _seq)` so duplicates from the two transports apply once. New tests: SSE fan-out, header forwarding, subscriber cleanup on disconnect, cross-context Playwright (no shared BC) sync. Suite 517/517 green.

---

### Task 3b — Remove BroadcastChannel [x]
**Goal:** clean up. Depends on Task 3a having shipped and proved stable.

- Delete `initStateChannel` / `closeStateChannel` / the BroadcastChannel post-on-save call.
- All sync is now SSE-driven.

**Tests**
- All cross-tab tests run on SSE only.

**Risk:** low if 3a has been stable for a release.

**Status notes:**
- 2026-05-27 — landed. `persistence.js` no longer creates a `BroadcastChannel`; `initStateChannel` opens only an `EventSource`. Per-tab `_seq` machinery deleted (cross-transport dedupe no longer needed). Saves still send `X-Tab-Id` so the server can route the SSE event back without echoing to the originator. All cross-tab/cross-context UI tests pass on SSE alone.

---

### Task 4 — Consistency sweep [x]
**Goal:** defensive recovery for dropped events / restarts. Depends on Task 3b.

- Client tracks last-seen `version`; on SSE reconnect or `visibilitychange → visible`, if server `version` is ahead, do one `GET /api/state` and reconcile targeted (re-render only what changed).
- Playwright: 3 tabs, mixed sequence of edits, then assert all 3 DOMs match the server JSON.

**Risk:** none — purely additive recovery.

**Status notes:**
- 2026-05-27 — landed. SSE `onmessage` tracks `lastSeenVersion`; any subsequent `hello` whose `_version` doesn't match emits a synthetic `{kind:'catchup'}` delta which `applyRemoteDelta` funnels into `fullRefresh()`. `fullRefresh` now defers (800 ms re-try) if there is pending debounced typing instead of dropping the refresh on the floor. SSE `onerror` sets a `sawDisconnect` flag; the visibilitychange→visible handler in `app.js` calls `maybeCatchupOnVisible()` which emits catchup if the connection had errored while the tab was hidden. New tests: 7 unit tests in `test/catchup.test.js` (first-hello/no-change/advance/restart/own-events/remount/visibility), an integration test for the server's `_version` monotonicity in hello + deltas, and a 3-tab Playwright consistency check covering "mixed edits on three tabs end in identical state on every tab and on disk".

---

## Open questions for review

- Confirm ordering 1a → 1b → 2 → 3a → 3b → 4 is what you want.
- Task 2 transport: payload-carrying BroadcastChannel message vs. `GET /api/state/recent` — I'm proposing payload-carrying because it's simpler; flag if you'd rather keep BC dumb.
- Anything else that should sync (revisions list, prompt bar, file-nav collapsed state)? Currently they're loaded once and not synced.

---

## Working log

Append a dated entry when a task changes status.

- 2026-05-27 — Task 1a complete.
- 2026-05-27 — Task 1b complete.
- 2026-05-27 — Task 2 complete.
- 2026-05-27 — Task 3a complete.
- 2026-05-27 — Task 3b complete.
- 2026-05-27 — Task 4 complete.  All six tasks done.  This plan file can be deleted after a final review pass.

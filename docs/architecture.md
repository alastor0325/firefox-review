# Client-side architecture

`public/app.js` is the entire browser-side application (~1 800 lines). This document describes its internal structure, the layering rules that keep it maintainable, and the conventions to follow when extending it.

## Layers

```
┌──────────────────────────────────────────────────────┐
│                   app.js (single file)               │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  Orchestrators                               │   │
│  │  loadAndRender · submitReview · init         │   │
│  │  initWorktreeBar · startUpdatePolling        │   │
│  └──────┬──────────────┬───────────────┬───────┘   │
│         │              │               │             │
│  ┌──────▼──────┐  ┌────▼──────┐  ┌────▼──────┐    │
│  │  Renderer   │  │Persistence│  │ Revisions │    │
│  │  renderTabs │  │ saveState │  │diffFinger-│    │
│  │  buildPatch │  │ scheduleA-│  │print      │    │
│  │  El · file  │  │ utoSave   │  │migrateApp-│    │
│  │  nav · etc. │  └────┬──────┘  │rovals     │    │
│  └──────┬──────┘       │         └────┬──────┘    │
│         │              │              │             │
│  ┌──────▼──────────────▼──────────────▼──────┐    │
│  │                  State                    │    │
│  │  state · approvePatch · denyPatch         │    │
│  │  setComment · deleteComment · etc.        │    │
│  └───────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

Arrows point **down** — a layer may only call into layers below it. The renderer reads state but never writes it. State mutators never call render functions.

## The state layer

All mutable application data lives in one object:

```javascript
const state = {
  patches: [],            // current patch series (from /api/diff)
  currentPatchIdx: 0,
  approved: new Set(),    // patch hashes the reviewer approved
  denied: new Set(),      // patch hashes the reviewer denied
  comments: {},           // [patchHash][filePath][lineKey] = commentObj
  generalComments: {},    // [patchHash] = string
  revisions: [],          // [{savedAt, patches:[{hash,message,diffFingerprint}]}]
  updatedPatches: {},     // {patchIdx: {oldHash, oldMessage}} — ephemeral, not persisted
  showRevision: {},       // {patchIdx: hash|null} — ephemeral revision toggle state
  compareRevision: {},    // {patchIdx: {from, to}|absent} — ephemeral compare mode
};
```

### Mutator contract

**State mutators are pure data operations.** They write to `state` and call `scheduleAutoSave()`, and nothing else:

```javascript
// Correct:
function approvePatch(hash) {
  state.approved.add(hash);
  scheduleAutoSave();
}

// Wrong — never do this:
function approvePatch(hash) {
  state.approved.add(hash);
  renderTabs();          // ← violates the contract
  updateSubmitButton();  // ← violates the contract
}
```

The caller is responsible for triggering any re-renders after a mutation. In practice, callers are always event handlers inside the renderer, which is the appropriate layer for scheduling DOM updates.

The reason this rule exists: if a mutator called a render function, and that render function imported from the state module in a future module split, you would get a circular dependency (`state → renderer → state`). Enforcing purity now keeps the dependency graph a strict DAG and makes the code testable without a DOM.

### Accessors

Read-only helpers (`getComment`, `commentsForPatch`, `getGeneralComment`, `allPatchesFinished`, `currentPatch`) are co-located with state. They take arguments and return values; they have no side effects.

## The persistence layer

`saveState` serialises `state.comments`, `state.generalComments`, `state.approved`, `state.denied`, and `state.revisions` to `/api/state` (a JSON file on disk).

`scheduleAutoSave` debounces saves with a 500 ms timer. The timer is stored in the module-level `saveTimer` variable. `loadAndRender` **flushes** any pending save before resetting state, so approvals made in the 500 ms window are not silently lost on reload.

## The revisions layer

### diffFingerprint

```javascript
function diffFingerprint(patch) { … }
```

Computes a string fingerprint of a patch's changed lines (added/removed only, not context). Two patches with the same fingerprint have identical code changes regardless of commit hash or message. Used to distinguish:

- **Hash-only changes** (rebase, message amend) → fingerprints match → migrate approval to new hash
- **Code changes** (actual diff content changed) → fingerprints differ → clear approval, reviewer must re-evaluate

### migrateApprovals

```javascript
function migrateApprovals(prevPatches, currPatches, approved, denied)
  → { approved: Set, denied: Set }
```

Pure function. Walks the two patch lists slot-by-slot. For each slot where the hash changed:

1. If fingerprints match (or neither has a fingerprint) → carry the approval/denial forward to the new hash.
2. If fingerprints differ → drop the decision; the reviewer must look again.

Returns new Sets; does not mutate the inputs.

### detectRevisionChanges

Called once per `loadAndRender`. Compares the current patch list against the most recent revision snapshot. If anything changed, records a new revision entry and runs `migrateApprovals` to update `state.approved`/`state.denied`. Keeps at most 10 revision snapshots.

## The renderer

All DOM construction and mutation lives here. Key functions:

| Function | Responsibility |
|---|---|
| `buildPatchEl(idx)` | Builds a complete patch element (detached) for a given index. Returns `{ el, diffWrap, navItemsEl }`. |
| `renderCurrentPatch()` | Rebuilds the current patch in-place, replacing the existing element. |
| `initPatchNodes()` | Builds all patch elements on initial load; only the active one is visible. |
| `renderTabs()` | Redraws the patch tab bar. Rebuilds from scratch if patch count changes; otherwise updates class/content in-place. |
| `switchPatch(idx)` | Hides the old patch element, shows the new one, updates tab active state. O(1) DOM ops. |
| `renderFile(fileData, patchHash)` | Builds one file diff block (header + hunk rows + expand rows + comment rows). |
| `buildNavItemsEl(files, diffWrap)` | Builds the file-nav items element (detached). |
| `activateFileNav(navItemsEl, diffWrap)` | Swaps in a pre-built nav items element and attaches the scroll highlight handler. |
| `updateSubmitButton()` | Enables/disables the Generate button based on current activity. |
| `refreshPromptBar()` | Shows/hides the current-prompt bar based on whether all patches are finished and a prompt exists. |

### Patch element lifecycle

```
loadAndRender()
  └─ initPatchNodes()
       ├─ buildPatchEl(0) → attached, visible
       ├─ buildPatchEl(1) → attached, hidden (display:none)
       └─ buildPatchEl(2) → attached, hidden

switchPatch(1)            → hide 0, show 1 (no rebuild)

approvePatch(hash)        → state mutated
  caller:
    renderTabs()          → update tab classes in-place
    renderCurrentPatch()  → buildPatchEl(1) again, replaceWith
```

`patchEls` is a module-level array that caches `{ el, diffWrap, navItemsEl }` for each patch. It is rebuilt on every `loadAndRender` and updated in-place on `renderCurrentPatch`.

### Expand-context rows

`renderExpandRow` manages its own state (current hidden range, known file length) in closure variables. Clicking ↑/↓ fetches from `/api/filecontext` and inserts context rows into the table without a full re-render. The expand row removes itself when the hidden range is exhausted.

## The orchestrators

These functions wire the layers together. They are allowed to call any layer.

### `loadAndRender()`

1. Flush any pending auto-save.
2. Reset all state (ephemeral and persisted).
3. Fetch `/api/diff` and `/api/state` in parallel.
4. Populate `state` from both responses.
5. Run `detectRevisionChanges` (migrate approvals, record revision).
6. Call `renderTabs`, `initPatchNodes`, `updateSubmitButton`, `refreshPromptBar`.

Safe to call multiple times — worktree switching calls it on each switch.

### `submitReview()`

1. Serialise current feedback into the POST body.
2. POST to `/api/submit`.
3. On success: show the result overlay, auto-copy the prompt to clipboard.
4. Clear `state.denied`, `state.comments`, `state.generalComments` (approved is kept — patches already signed off remain so across review cycles).
5. Save state, re-render tabs and current patch.

### `init()`

Attaches all top-level event listeners (submit button, copy buttons, modal close, reload banner). Calls `initWorktreeBar()` then `loadAndRender()`.

### `startUpdatePolling()`

Polls `/api/headhash` every 5 seconds. Shows the reload banner when the hash changes. Does not auto-reload — the reviewer decides when to pull in new diffs.

## Revision UI

When a patch has been seen in multiple revisions (`getRevisionList` returns length > 1), `buildPatchEl` renders a revision bar above the diff.

Two modes:
- **Single-revision view** — a row of buttons, one per revision. Clicking a non-current button fetches `/api/patchdiff/:hash` and renders that version read-only.
- **Compare mode** — two rows (From / To). Clicking the `⇄` button enters compare mode; `renderCurrentPatch` then fetches `/api/revdiff?from=…&to=…` and renders the between-revision diff.

Both modes are stored in `state.showRevision` and `state.compareRevision` (ephemeral — not persisted across reloads).

## Module split roadmap

The file is currently monolithic for simplicity (single `<script>` tag, CommonJS test compat via `if (typeof module !== 'undefined')`). The layer boundaries described above are the intended split points for a future ES-module conversion:

```
public/
  state.js        ← state object, pure mutators/accessors
  persistence.js  ← saveState, scheduleAutoSave, resetReviewState
  revisions.js    ← diffFingerprint, migrateApprovals, detectRevisionChanges
  renderer.js     ← all DOM construction and event wiring
  app.js          ← orchestrators, DOMContentLoaded entry point
```

Because mutators are already pure, `state.js` will have no imports at all. The only allowed import direction is downward through the stack shown in the diagram at the top of this document.

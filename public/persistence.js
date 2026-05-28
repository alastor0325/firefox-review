import { state, allPatchesFinished } from './state.js';

// ── Cross-tab sync ─────────────────────────────────────────────────────────
// Each save broadcasts a delta describing what changed so peer tabs can
// apply a targeted update instead of refetching the entire state and
// re-rendering (which would clobber any open form mid-typing).
let stateChannel = null;
const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function initStateChannel(worktreeName, onRemoteDelta) {
  if (typeof BroadcastChannel === 'undefined') return null;
  closeStateChannel();
  stateChannel = new BroadcastChannel(`revue-state-${worktreeName}`);
  stateChannel.onmessage = (e) => {
    if (!e.data || e.data.tabId === TAB_ID) return;
    if (e.data.type === 'delta') onRemoteDelta(e.data.delta);
  };
  return stateChannel;
}

export function closeStateChannel() {
  if (stateChannel) { stateChannel.close(); stateChannel = null; }
}

function broadcastDelta(delta) {
  if (!stateChannel) return;
  try { stateChannel.postMessage({ type: 'delta', tabId: TAB_ID, delta }); }
  catch { /* channel closed mid-save — ignore */ }
}

// ── Save-status indicator ──────────────────────────────────────────────────
let pendingSaves = 0;
function indicator() { return document.querySelector('#autosave-status'); }
function showSaving() {
  pendingSaves++;
  const el = indicator();
  if (el) el.textContent = 'Saving…';
}
function showSaved() {
  pendingSaves = Math.max(0, pendingSaves - 1);
  const el = indicator();
  if (!el) return;
  if (pendingSaves === 0) {
    el.textContent = 'Saved';
    setTimeout(() => { if (el && pendingSaves === 0) el.textContent = ''; }, 2000);
  }
}
function showFailed() {
  pendingSaves = Math.max(0, pendingSaves - 1);
  const el = indicator();
  if (el) el.textContent = 'Save failed';
}

async function postJson(url, body, delta) {
  showSaving();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { showFailed(); return false; }
    showSaved();
    if (delta) broadcastDelta(delta);
    return true;
  } catch {
    showFailed();
    return false;
  }
}

// ── Delta saves ────────────────────────────────────────────────────────────
// Each save targets one logical entry of the persisted state.  Two tabs
// editing different entries cannot clobber each other because the server
// serialises read-modify-write under a per-worktree lock.

export function saveCommentNow(patchHash, file, key, comment) {
  return postJson(
    '/api/state/comment',
    { patchHash, file, key, comment },
    { kind: 'comment', patchHash, file, key, value: comment },
  );
}

export function saveDecisionNow(patchHash, kind) {
  return postJson(
    '/api/state/decision',
    { patchHash, kind },
    { kind: 'decision', patchHash, action: kind },
  );
}

export function saveRevisionsNow(revisions, approved, denied) {
  return postJson(
    '/api/state/revisions',
    { revisions, approved, denied },
    { kind: 'revisions' },
  );
}

// ── Debounced saves for typed text ─────────────────────────────────────────
// Drafts and general-comment text are typed character-by-character.  Debounce
// so we hit the server once per ~500 ms of typing per key.  Track per-key
// timers in a Map so quickly switching between two drafts doesn't lose either.
const DEBOUNCE_MS = 500;

function makeDebouncedSaver(url, buildBody, buildDelta) {
  const pending = new Map(); // key -> { payload, timer }
  function fire(key, payload) {
    return postJson(url, buildBody(key, payload), buildDelta(key, payload));
  }
  return {
    schedule(key, payload) {
      const prev = pending.get(key);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        pending.delete(key);
        fire(key, payload);
      }, DEBOUNCE_MS);
      pending.set(key, { payload, timer });
    },
    cancelKey(key) {
      const prev = pending.get(key);
      if (prev) { clearTimeout(prev.timer); pending.delete(key); }
    },
    flushAll() {
      const all = [];
      for (const [key, { payload, timer }] of pending) {
        clearTimeout(timer);
        all.push(fire(key, payload));
      }
      pending.clear();
      return Promise.all(all);
    },
    cancelAll() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },
    hasPending() { return pending.size > 0; },
  };
}

const draftSaver = makeDebouncedSaver(
  '/api/state/draft',
  (key, text) => ({ key, text }),
  (key, text) => ({ kind: 'draft', key, value: text }),
);
const gcSaver = makeDebouncedSaver(
  '/api/state/general-comment',
  (patchHash, text) => ({ patchHash, text }),
  (patchHash, text) => ({ kind: 'general-comment', patchHash, value: text }),
);

export function scheduleDraftSave(key, text) { draftSaver.schedule(key, text); }
export function scheduleGeneralCommentSave(patchHash, text) { gcSaver.schedule(patchHash, text); }

// Immediate draft save — for explicit "discard" actions where waiting for the
// debounce would visibly leak the cleared draft into other tabs.
export function saveDraftNow(key, text) {
  draftSaver.cancelKey(key);
  return postJson(
    '/api/state/draft',
    { key, text },
    { kind: 'draft', key, value: text },
  );
}

export function hasPendingSave() {
  return draftSaver.hasPending() || gcSaver.hasPending();
}

// Flush every pending debounced save.  Called by loadAndRender before the
// state reset so keystrokes typed within the debounce window survive reload.
export async function flushSave() {
  await Promise.all([draftSaver.flushAll(), gcSaver.flushAll()]);
}

// Cancel pending saves without persisting them.  Used by the submit flow,
// which is about to bulk-write a cleared state — flushing the in-flight
// drafts would re-create the values we are trying to clear.
export function cancelPendingSaves() {
  draftSaver.cancelAll();
  gcSaver.cancelAll();
}

// ── Bulk save (submit-reset only) ──────────────────────────────────────────
// The submit flow clears comments/generalComments/denied/drafts in one shot
// and preserves approved.  Using delta endpoints here would mean N+M POSTs
// for N comments and M drafts — the bulk endpoint exists for exactly this.
export async function saveStateBulk(payload) {
  return postJson('/api/state', payload, { kind: 'bulk' });
}

// ── Prompt bar ─────────────────────────────────────────────────────────────
let savedPromptText = null;
export function getSavedPromptText() { return savedPromptText; }
export function setSavedPromptText(v) { savedPromptText = v; }

export function updateCurrentPrompt(prompt) {
  savedPromptText = prompt;
  refreshPromptBar();
}

export function refreshPromptBar() {
  const bar = document.querySelector('#current-prompt-bar');
  if (!bar) return;
  if (savedPromptText && allPatchesFinished()) {
    bar.dataset.prompt = savedPromptText;
    bar.style.display = '';
  } else {
    bar.style.display = 'none';
  }
}

// Allow unit tests to import without a full browser environment.
if (typeof module !== 'undefined') {
  module.exports = {
    saveCommentNow, saveDecisionNow, saveRevisionsNow,
    scheduleDraftSave, saveDraftNow, scheduleGeneralCommentSave,
    saveStateBulk,
    flushSave, hasPendingSave, cancelPendingSaves,
    initStateChannel, closeStateChannel,
    updateCurrentPrompt, refreshPromptBar, getSavedPromptText, setSavedPromptText,
  };
}

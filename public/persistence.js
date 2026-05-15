import { state, drafts, allPatchesFinished } from './state.js';

// ── Auto-save ──────────────────────────────────────────────────────────────
let saveTimer = null;
let savedPromptText = null;

// Cross-tab sync.  Without this, a second tab holding stale in-memory state
// would overwrite a comment another tab just saved on its next auto-save.
let stateChannel = null;
const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const MSG_STATE_UPDATED = 'state-updated';

export function initStateChannel(worktreeName, onRemoteUpdate) {
  if (typeof BroadcastChannel === 'undefined') return null;
  closeStateChannel();
  stateChannel = new BroadcastChannel(`revue-state-${worktreeName}`);
  stateChannel.onmessage = (e) => {
    if (e.data && e.data.type === MSG_STATE_UPDATED && e.data.tabId !== TAB_ID) {
      onRemoteUpdate();
    }
  };
  return stateChannel;
}

export function closeStateChannel() {
  if (stateChannel) { stateChannel.close(); stateChannel = null; }
}

export function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 500);
}

export function hasPendingSave() { return saveTimer !== null; }

// Flush any pending auto-save immediately.  Called by loadAndRender before
// resetting state so approvals made within the debounce window are not lost.
export async function flushSave() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveState();
  }
}

export async function saveState() {
  // Reset before awaiting fetch so hasPendingSave() reads false during the
  // in-flight POST, and a new edit during that window schedules a fresh timer.
  saveTimer = null;
  const indicator = document.querySelector('#autosave-status');
  if (indicator) indicator.textContent = 'Saving…';
  try {
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comments: state.comments,
        generalComments: state.generalComments,
        approved: [...state.approved],
        denied: [...state.denied],
        revisions: state.revisions,
        drafts,
      }),
    });
    if (res.ok && stateChannel) {
      try { stateChannel.postMessage({ type: MSG_STATE_UPDATED, tabId: TAB_ID }); }
      catch { /* channel closed mid-save — ignore */ }
    }
    if (indicator) {
      indicator.textContent = 'Saved';
      setTimeout(() => { if (indicator) indicator.textContent = ''; }, 2000);
    }
  } catch {
    if (indicator) indicator.textContent = 'Save failed';
  }
}

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
    scheduleAutoSave, flushSave, saveState, hasPendingSave,
    initStateChannel, closeStateChannel,
    updateCurrentPrompt, refreshPromptBar, getSavedPromptText, setSavedPromptText,
  };
}

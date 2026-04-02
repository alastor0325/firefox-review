import { state, allPatchesFinished } from './state.js';

// ── Auto-save ──────────────────────────────────────────────────────────────
let saveTimer = null;
let savedPromptText = null;

export function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 500);
}

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
  const indicator = document.querySelector('#autosave-status');
  if (indicator) indicator.textContent = 'Saving…';
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comments: state.comments,
        generalComments: state.generalComments,
        approved: [...state.approved],
        denied: [...state.denied],
        revisions: state.revisions,
      }),
    });
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
  module.exports = { scheduleAutoSave, flushSave, saveState, updateCurrentPrompt, refreshPromptBar, getSavedPromptText, setSavedPromptText };
}

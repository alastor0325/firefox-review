// State: direct access for orchestration
import { state, drafts, draftKey, resetReviewState, commentsForPatch, getGeneralComment } from './state.js';
// Persistence: save/restore + prompt bar
import { flushSave, saveState, updateCurrentPrompt, refreshPromptBar, setSavedPromptText } from './persistence.js';
// Revisions: detect changes on load
import { diffFingerprint, migrateApprovals, detectRevisionChanges } from './revisions.js';
// Renderer: all DOM functions + re-exportable items for tests
import {
  patchEls, updateSubmitButton, removeExistingForm, showCommentForm,
  renderDraftDisplay, renderCommitMessageSection, renderFileNav, renderFile,
  renderTabs, switchPatch, buildPatchEl, renderCurrentPatch, initPatchNodes,
  addDragScroll, initTabsDragScroll, getFileNavCollapsed, setFileNavCollapsed,
} from './renderer.js';

// ── DOM helpers ────────────────────────────────────────────────────────────
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _pollTimer = null;

// ── Submit review ──────────────────────────────────────────────────────────
async function submitReview() {
  const allFeedback = state.patches.map((p) => ({
    hash: p.hash,
    comments: commentsForPatch(p.hash),
    generalComment: getGeneralComment(p.hash).trim(),
  }));

  const btn = $('#btn-submit');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  let submitError = null;
  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allFeedback,
        approvedHashes: [...state.approved],
        deniedHashes:   [...state.denied],
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Server error');

    $('#result-feedback-path').textContent = json.feedbackPath;
    $('#result-prompt').value = json.prompt;
    $('#result-overlay').classList.add('visible');
    updateCurrentPrompt(json.prompt);

    navigator.clipboard.writeText(json.prompt).then(() => {
      const copyBtn = $('#btn-copy-prompt');
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy prompt'; }, 2000);
    }).catch(() => {});  // silently ignore if clipboard access is denied

    // Keep approved — patches already signed off on remain so across review
    // cycles.  Only clear denied and feedback which are expected to change.
    state.comments = {};
    state.generalComments = {};
    state.denied = new Set();
    await saveState();

    renderTabs();
    initPatchNodes();
  } catch (err) {
    submitError = err.message;
  } finally {
    btn.textContent = 'Generate Review Prompt';
    updateSubmitButton();
    // Set error AFTER updateSubmitButton so it is not cleared when hasActivity is true
    if (submitError) {
      const warn = $('#submit-warning');
      if (warn) warn.textContent = `Error: ${submitError}`;
    }
  }
}

// ── Worktree switcher ──────────────────────────────────────────────────────
async function initWorktreeBar() {
  try {
    const res = await fetch('/api/worktrees');
    if (!res.ok) return;
    let { current, worktrees } = await res.json();
    if (worktrees.length <= 1) return; // nothing to switch to

    // ── Hash navigation: switch to worktree named in URL hash on load ──
    const hashName = window.location.hash.slice(1);
    if (hashName && hashName !== current) {
      const target = worktrees.find((wt) => wt.worktreeName === hashName);
      if (target) {
        const r = await fetch('/api/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeName: hashName }),
        });
        if (r.ok) current = hashName;
      }
    }

    // Keep URL hash in sync with active worktree
    history.replaceState(null, '', '#' + current);

    const bar = $('#worktree-bar');
    const pills = $('#worktree-pills');
    const btnLeft = $('#worktree-scroll-left');
    const btnRight = $('#worktree-scroll-right');

    pills.innerHTML = worktrees.map((wt) =>
      `<button class="worktree-pill${wt.worktreeName === current ? ' active' : ''}" data-name="${escapeHtml(wt.worktreeName)}">${escapeHtml(wt.worktreeName)}</button>`
    ).join('');

    // Scroll arrow logic
    function updateScrollBtns() {
      const atLeft = pills.scrollLeft <= 0;
      const atRight = pills.scrollLeft + pills.clientWidth >= pills.scrollWidth - 1;
      btnLeft.disabled = atLeft;
      btnRight.disabled = atRight;
      btnLeft.style.display = pills.scrollWidth <= pills.clientWidth ? 'none' : '';
      btnRight.style.display = pills.scrollWidth <= pills.clientWidth ? 'none' : '';
    }
    const SCROLL_STEP = 160;
    btnLeft.addEventListener('click', () => { pills.scrollBy({ left: -SCROLL_STEP, behavior: 'smooth' }); });
    btnRight.addEventListener('click', () => { pills.scrollBy({ left: SCROLL_STEP, behavior: 'smooth' }); });
    pills.addEventListener('scroll', updateScrollBtns, { passive: true });
    // Re-check after layout (fonts/widths may not be ready yet)
    setTimeout(updateScrollBtns, 50);

    pills.addEventListener('click', async (e) => {
      const btn = e.target.closest('.worktree-pill');
      if (!btn || btn.classList.contains('active')) return;
      const name = btn.dataset.name;
      btn.textContent = 'Switching…';
      btn.disabled = true;
      try {
        const r = await fetch('/api/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeName: name }),
        });
        if (!r.ok) throw new Error('Switch failed');
        history.replaceState(null, '', '#' + name);
        // Update active pill
        pills.querySelectorAll('.worktree-pill').forEach((p) => {
          p.classList.toggle('active', p.dataset.name === name);
          p.disabled = false;
          p.textContent = p.dataset.name;
        });
        await loadAndRender();
      } catch {
        btn.textContent = name;
        btn.disabled = false;
      }
    });

    bar.style.display = '';

    // Handle hash changes after page load (e.g. user edits hash in address bar).
    // Remove any previous listener before adding a new one so re-initialisation
    // (e.g. in tests) never accumulates duplicate handlers.
    if (initWorktreeBar._hashHandler) {
      window.removeEventListener('hashchange', initWorktreeBar._hashHandler);
    }
    initWorktreeBar._hashHandler = async () => {
      const name = window.location.hash.slice(1);
      if (!name) return;
      const active = pills.querySelector('.worktree-pill.active');
      if (active && active.dataset.name === name) return; // already on it
      const target = worktrees.find((wt) => wt.worktreeName === name);
      if (!target) return;
      pills.querySelectorAll('.worktree-pill').forEach((p) => {
        p.disabled = p.dataset.name !== name;
        if (p.dataset.name === name) p.textContent = 'Switching…';
      });
      try {
        const r = await fetch('/api/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeName: name }),
        });
        if (!r.ok) throw new Error('Switch failed');
        pills.querySelectorAll('.worktree-pill').forEach((p) => {
          p.classList.toggle('active', p.dataset.name === name);
          p.disabled = false;
          p.textContent = p.dataset.name;
        });
        await loadAndRender();
      } catch {
        pills.querySelectorAll('.worktree-pill').forEach((p) => {
          p.disabled = false;
          p.textContent = p.dataset.name;
        });
      }
    };
    window.addEventListener('hashchange', initWorktreeBar._hashHandler);
  } catch { /* non-fatal */ }
}

// ── Boot ───────────────────────────────────────────────────────────────────
// Fetches diff + state from the server and re-renders everything in-place.
// Safe to call multiple times (worktree switch, manual refresh).
async function loadAndRender() {
  // Flush any pending auto-save before resetting state.  If we just cancel
  // the timer, approvals made after the last successful save are silently
  // lost when the user reloads before the 500 ms debounce fires.  Saving
  // first ensures they land on disk and are restored below.
  await flushSave();
  // Reset ephemeral state before loading new worktree data
  resetReviewState();
  state.patches = [];
  state.currentPatchIdx = 0;
  state.revisions = [];
  state.updatedPatches = {};
  state.showRevision = {};
  state.compareRevision = {};

  const loading = $('#loading');
  const errorMsg = $('#error-msg');
  const filesChanged = $('#files-changed');

  loading.style.display = '';
  errorMsg.style.display = 'none';
  filesChanged.style.display = 'none';

  try {
    const [diffRes, stateRes] = await Promise.all([fetch('/api/diff'), fetch('/api/state')]);

    const data = await diffRes.json();
    if (!diffRes.ok) throw new Error(data.error || 'Failed to load diff');

    if (stateRes.ok) {
      const saved = await stateRes.json();
      if (saved.comments) state.comments = saved.comments;
      if (saved.generalComments) state.generalComments = saved.generalComments;
      if (saved.approved) state.approved = new Set(saved.approved);
      if (saved.denied) state.denied = new Set(saved.denied);
      if (saved.prompt) setSavedPromptText(saved.prompt);
      if (saved.revisions) state.revisions = saved.revisions;
    }

    state.patches = data.patches || [];
    state.currentPatchIdx = 0;

    $('#bug-id-display').textContent = data.worktreeName;
    $('#worktree-path').textContent = data.worktreePath;
    if (data.repoName) document.title = `${data.repoName}-${data.worktreeName}`;

    loading.style.display = 'none';
    filesChanged.style.display = '';

    detectRevisionChanges();
    renderTabs();
    initPatchNodes();
    updateSubmitButton();
    refreshPromptBar();
  } catch (err) {
    loading.style.display = 'none';
    errorMsg.style.display = '';
    errorMsg.textContent = `Error loading diff: ${err.message}`;
  }
}

async function init() {
  updateSubmitButton();

  $('#btn-submit').addEventListener('click', submitReview);
  initTabsDragScroll();

  $('#btn-copy-prompt').addEventListener('click', () => {
    const prompt = $('#result-prompt').value;
    navigator.clipboard.writeText(prompt).then(() => {
      $('#btn-copy-prompt').textContent = 'Copied!';
      setTimeout(() => { $('#btn-copy-prompt').textContent = 'Copy prompt'; }, 2000);
    });
  });

  $('#btn-copy-current-prompt').addEventListener('click', () => {
    const bar = $('#current-prompt-bar');
    const prompt = bar && bar.dataset.prompt;
    if (!prompt) return;
    navigator.clipboard.writeText(prompt).then(() => {
      $('#btn-copy-current-prompt').textContent = 'Copied!';
      setTimeout(() => { $('#btn-copy-current-prompt').textContent = 'Copy current prompt'; }, 2000);
    });
  });

  $('#btn-close-modal').addEventListener('click', () => {
    $('#result-overlay').classList.remove('visible');
  });

  $('#result-overlay').addEventListener('click', (e) => {
    if (e.target === $('#result-overlay')) {
      $('#result-overlay').classList.remove('visible');
    }
  });

  $('#btn-reload-page').addEventListener('click', async () => {
    $('#update-banner').style.display = 'none';
    await loadAndRender();
  });

  await initWorktreeBar(); // awaited so hash-based switch completes before first render
  await loadAndRender();
}

// ── Update detection ───────────────────────────────────────────────────────
// Polls /api/headhash every 5 seconds; shows a reload banner when the
// worktree HEAD changes (i.e. commits were amended or added).
async function startUpdatePolling() {
  let knownHash = null;
  try {
    const res = await fetch('/api/headhash');
    if (!res.ok) return;
    ({ hash: knownHash } = await res.json());
  } catch {
    return; // endpoint unavailable (e.g. demo mode) — silently skip
  }

  _pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/headhash');
      if (!res.ok) return;
      const { hash } = await res.json();
      if (hash !== knownHash) {
        knownHash = hash;
        $('#update-banner').style.display = '';
      }
    } catch { /* ignore network errors */ }
  }, 5000);
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  startUpdatePolling();
});

// Allow unit tests to import pure helpers without loading the full browser app.
if (typeof module !== 'undefined') {
  module.exports = {
    // state.js re-exports (for test backward compat)
    state, drafts, draftKey,
    // revisions.js re-exports (for test backward compat)
    diffFingerprint, migrateApprovals,
    // renderer.js re-exports (for test backward compat)
    renderDraftDisplay, removeExistingForm, showCommentForm,
    renderFileNav, renderFile,
    getFileNavCollapsed, setFileNavCollapsed,
    renderCommitMessageSection,
    buildPatchEl,
    initPatchNodes,
    renderTabs,
    switchPatch,
    patchEls,
    addDragScroll,
    // app.js exports
    submitReview,
    loadAndRender,
    init,
    initWorktreeBar,
    getPollTimer: () => _pollTimer,
  };
}


'use strict';

// ── State ──────────────────────────────────────────────────────────────────
// comments[file][lineKey] = { file, line, lineContent, text }
// lineKey = `${newLineNum ?? 'r'+oldLineNum}`
const state = {
  comments: {},   // keyed by file path, then by lineKey
  diffData: null, // full API response
};

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

// ── Comment management ─────────────────────────────────────────────────────
function lineKey(line) {
  return line.newLineNum != null ? `n${line.newLineNum}` : `r${line.oldLineNum}`;
}

function getComment(filePath, key) {
  return (state.comments[filePath] || {})[key] || null;
}

function setComment(filePath, key, commentObj) {
  if (!state.comments[filePath]) state.comments[filePath] = {};
  state.comments[filePath][key] = commentObj;
  updateSubmitButton();
}

function deleteComment(filePath, key) {
  if (state.comments[filePath]) {
    delete state.comments[filePath][key];
    if (Object.keys(state.comments[filePath]).length === 0) {
      delete state.comments[filePath];
    }
  }
  updateSubmitButton();
}

function allComments() {
  const list = [];
  for (const filePath of Object.keys(state.comments)) {
    for (const key of Object.keys(state.comments[filePath])) {
      list.push(state.comments[filePath][key]);
    }
  }
  return list;
}

// ── Submit button state ────────────────────────────────────────────────────
function updateSubmitButton() {
  const btn = $('#btn-submit');
  const warn = $('#submit-warning');
  const count = allComments().length;
  if (count === 0) {
    btn.disabled = true;
    warn.textContent = 'Add at least one comment first';
  } else {
    btn.disabled = false;
    warn.textContent = `${count} comment${count !== 1 ? 's' : ''} ready`;
  }
}

// ── Inline comment form ────────────────────────────────────────────────────
function removeExistingForm() {
  const existing = $('.comment-form-row');
  if (existing) existing.remove();
}

function showCommentForm(tr, filePath, line, key) {
  removeExistingForm();

  const formRow = document.createElement('tr');
  formRow.className = 'comment-form-row';
  formRow.innerHTML = `
    <td colspan="3">
      <div class="comment-form-inner">
        <textarea placeholder="Leave a comment on this line…" autofocus></textarea>
        <div class="comment-actions">
          <button class="btn-cancel">Cancel</button>
          <button class="btn-save">Save comment</button>
        </div>
      </div>
    </td>`;

  tr.after(formRow);

  const textarea = formRow.querySelector('textarea');
  // Pre-fill if editing
  const existing = getComment(filePath, key);
  if (existing) textarea.value = existing.text;
  textarea.focus();

  formRow.querySelector('.btn-cancel').addEventListener('click', () => {
    formRow.remove();
  });

  formRow.querySelector('.btn-save').addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) return;

    const commentObj = {
      file: filePath,
      line: line.newLineNum != null ? line.newLineNum : line.oldLineNum,
      lineContent: line.content,
      text,
    };
    setComment(filePath, key, commentObj);
    formRow.remove();
    renderCommentDisplay(tr, filePath, line, key);
  });
}

function renderCommentDisplay(trLine, filePath, line, key) {
  // Remove any existing display row for this key
  const existingDisplay = trLine.nextElementSibling;
  if (existingDisplay && existingDisplay.classList.contains('comment-display-row') &&
      existingDisplay.dataset.lineKey === key) {
    existingDisplay.remove();
  }

  const comment = getComment(filePath, key);
  if (!comment) return;

  const lineNum = line.newLineNum != null ? line.newLineNum : line.oldLineNum;
  const displayRow = document.createElement('tr');
  displayRow.className = 'comment-display-row';
  displayRow.dataset.lineKey = key;
  displayRow.innerHTML = `
    <td colspan="3">
      <div class="comment-display-inner">
        <div style="flex:1">
          <div class="comment-meta">Line ${lineNum} · ${escapeHtml(filePath)}</div>
          <div class="comment-body">${escapeHtml(comment.text)}</div>
        </div>
        <button class="btn-delete-comment" title="Delete comment">×</button>
      </div>
    </td>`;

  trLine.after(displayRow);

  displayRow.querySelector('.btn-delete-comment').addEventListener('click', () => {
    deleteComment(filePath, key);
    displayRow.remove();
  });

  // Click on comment body to re-edit
  displayRow.querySelector('.comment-body').style.cursor = 'pointer';
  displayRow.querySelector('.comment-body').addEventListener('click', () => {
    displayRow.remove();
    showCommentForm(trLine, filePath, line, key);
  });
}

// ── Diff rendering ─────────────────────────────────────────────────────────
function countStats(hunks) {
  let added = 0, removed = 0;
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.type === 'added') added++;
      else if (l.type === 'removed') removed++;
    }
  }
  return { added, removed };
}

function renderFile(fileData) {
  const filePath = fileData.newPath || fileData.oldPath || '(unknown)';
  const { added, removed } = countStats(fileData.hunks);

  const block = document.createElement('div');
  block.className = 'file-block';

  // Header
  const header = document.createElement('div');
  header.className = 'file-header';
  header.innerHTML = `
    <span class="file-toggle">▼</span>
    <span class="file-path">${escapeHtml(filePath)}</span>
    <span class="file-stats">
      <span class="stat-add">+${added}</span>
      <span class="stat-del">-${removed}</span>
    </span>`;
  block.appendChild(header);

  // Diff body
  const body = document.createElement('div');
  body.className = 'diff-body';

  const table = document.createElement('table');
  table.className = 'diff-table';

  for (const hunk of fileData.hunks) {
    // Hunk header row
    const hunkTr = document.createElement('tr');
    hunkTr.className = 'hunk-header';
    hunkTr.innerHTML = `<td colspan="3">${escapeHtml(hunk.header)}</td>`;
    table.appendChild(hunkTr);

    for (const line of hunk.lines) {
      const tr = document.createElement('tr');
      const typeClass =
        line.type === 'added' ? 'line-added' :
        line.type === 'removed' ? 'line-removed' : 'line-context';
      tr.className = typeClass;

      const prefix =
        line.type === 'added' ? '+' :
        line.type === 'removed' ? '-' : ' ';

      const oldNum = line.oldLineNum != null ? line.oldLineNum : '';
      const newNum = line.newLineNum != null ? line.newLineNum : '';

      tr.innerHTML = `
        <td class="ln-old">${escapeHtml(String(oldNum))}</td>
        <td class="ln-new">${escapeHtml(String(newNum))}</td>
        <td class="ln-content"><span class="line-icon">＋</span>${escapeHtml(prefix + line.content)}</td>`;

      // Click to add comment
      const key = lineKey(line);
      tr.querySelector('.ln-content').addEventListener('click', () => {
        // If form already open on this row, close it
        const next = tr.nextElementSibling;
        if (next && next.classList.contains('comment-form-row')) {
          next.remove();
          return;
        }
        removeExistingForm();
        showCommentForm(tr, filePath, line, key);
      });

      table.appendChild(tr);

      // Render any existing comment for this line (e.g. after page refresh — won't happen
      // in SPA but kept for completeness when re-rendering)
      if (getComment(filePath, key)) {
        renderCommentDisplay(tr, filePath, line, key);
      }
    }
  }

  body.appendChild(table);
  block.appendChild(body);

  // Toggle collapse
  let collapsed = false;
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    header.querySelector('.file-toggle').classList.toggle('collapsed', collapsed);
  });

  return block;
}

// ── Main render ────────────────────────────────────────────────────────────
function renderDiff(data) {
  state.diffData = data;

  // Header
  $('#bug-id-display').textContent = `Bug ${data.bugId}`;
  $('#worktree-path').textContent = data.worktreePath;

  const commitList = $('#commit-list');
  commitList.innerHTML = '';
  if (data.commits.length === 0) {
    const li = document.createElement('li');
    li.textContent = '(no commits ahead of base)';
    commitList.appendChild(li);
  } else {
    for (const c of data.commits) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="hash">${escapeHtml(c.hash)}</span>${escapeHtml(c.message)}`;
      commitList.appendChild(li);
    }
  }

  // Files
  const container = $('#files-changed');
  container.innerHTML = '<h2>Files changed</h2>';

  if (data.files.length === 0) {
    const msg = document.createElement('p');
    msg.style.color = '#8b949e';
    msg.textContent = 'No changed files found.';
    container.appendChild(msg);
    return;
  }

  for (const fileData of data.files) {
    container.appendChild(renderFile(fileData));
  }
}

// ── Submit review ──────────────────────────────────────────────────────────
async function submitReview() {
  const comments = allComments();
  if (comments.length === 0) return;

  const btn = $('#btn-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments }),
    });
    const json = await res.json();

    if (!res.ok) throw new Error(json.error || 'Server error');

    // Show result overlay
    $('#result-feedback-path').textContent = json.feedbackPath;
    $('#result-command').textContent = json.command;
    const overlay = $('#result-overlay');
    overlay.classList.add('visible');
  } catch (err) {
    alert(`Error submitting review: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit Review to Claude';
    updateSubmitButton();
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  updateSubmitButton();

  $('#btn-submit').addEventListener('click', submitReview);

  $('#btn-copy-command').addEventListener('click', () => {
    const cmd = $('#result-command').textContent;
    navigator.clipboard.writeText(cmd).then(() => {
      $('#btn-copy-command').textContent = 'Copied!';
      setTimeout(() => { $('#btn-copy-command').textContent = 'Copy command'; }, 2000);
    });
  });

  $('#btn-close-modal').addEventListener('click', () => {
    $('#result-overlay').classList.remove('visible');
  });

  // Close modal on backdrop click
  $('#result-overlay').addEventListener('click', (e) => {
    if (e.target === $('#result-overlay')) {
      $('#result-overlay').classList.remove('visible');
    }
  });

  // Load diff
  const loading = $('#loading');
  const errorMsg = $('#error-msg');
  const filesChanged = $('#files-changed');

  try {
    const res = await fetch('/api/diff');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load diff');
    loading.style.display = 'none';
    filesChanged.style.display = '';
    renderDiff(data);
  } catch (err) {
    loading.style.display = 'none';
    errorMsg.style.display = '';
    errorMsg.textContent = `Error loading diff: ${err.message}`;
  }
}

document.addEventListener('DOMContentLoaded', init);

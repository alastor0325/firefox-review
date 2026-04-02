import { state } from './state.js';
import { scheduleAutoSave } from './persistence.js';

// ── Revision detection ─────────────────────────────────────────────────────

/**
 * Compute a fingerprint of a patch's actual changed lines (added/removed only,
 * not context).  Two patches with identical fingerprints have the same net code
 * change even if the commit hash or message differs.
 */
export function diffFingerprint(patch) {
  const lines = [];
  for (const file of (patch.files || [])) {
    for (const hunk of (file.hunks || [])) {
      for (const line of hunk.lines) {
        if (line.type !== 'context') lines.push(line.type[0] + line.content);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Migrate approved/denied hashes when patches at the same position are
 * amended (i.e. same slot, different hash).  This preserves review decisions
 * across rebases so the reviewer doesn't lose previously recorded approvals.
 *
 * Pure function — returns new Sets, does not mutate the inputs.
 */
export function migrateApprovals(prevPatches, currPatches, approved, denied) {
  const newApproved = new Set(approved);
  const newDenied   = new Set(denied);
  for (let i = 0; i < Math.min(prevPatches.length, currPatches.length); i++) {
    const prev = prevPatches[i];
    const curr = currPatches[i];
    if (prev.hash === curr.hash) continue;

    // When both snapshots carry a diff fingerprint, use it to decide whether
    // the actual code changed.  If only hashes differ (e.g. a commit-message
    // amend or a rebase that didn't touch this patch) keep the decision.
    // If both fingerprints are absent (old state file) fall back to the same
    // keep-decision behaviour so we don't silently drop existing approvals.
    const hasFp = prev.diffFingerprint !== undefined && curr.diffFingerprint !== undefined;
    const diffChanged = hasFp && prev.diffFingerprint !== curr.diffFingerprint;

    if (diffChanged) {
      // Actual code changed — reviewer must re-evaluate
      newApproved.delete(prev.hash);
      newDenied.delete(prev.hash);
    } else {
      // Same diff (or no fingerprint to compare) — carry the decision forward
      if (newApproved.has(prev.hash)) {
        newApproved.delete(prev.hash);
        newApproved.add(curr.hash);
      }
      if (newDenied.has(prev.hash)) {
        newDenied.delete(prev.hash);
        newDenied.add(curr.hash);
      }
    }
  }
  return { approved: newApproved, denied: newDenied };
}

export function detectRevisionChanges() {
  if (state.patches.length === 0) return;

  const lastRevision = state.revisions[state.revisions.length - 1];
  const currentSnapshot = state.patches.map((p) => ({
    hash: p.hash,
    message: p.message,
    diffFingerprint: diffFingerprint(p),
  }));

  if (!lastRevision) {
    // First time — record baseline, nothing to compare against
    state.revisions.push({ savedAt: new Date().toISOString(), patches: currentSnapshot });
    scheduleAutoSave();
    return;
  }

  let hasChanges = false;
  const prevPatches = lastRevision.patches;
  for (let i = 0; i < Math.max(state.patches.length, prevPatches.length); i++) {
    const curr = state.patches[i];
    const prev = prevPatches[i];
    if (!curr || !prev || curr.hash !== prev.hash) {
      if (curr && prev) {
        state.updatedPatches[i] = { oldHash: prev.hash, oldMessage: prev.message };
      }
      hasChanges = true;
    }
  }

  if (hasChanges) {
    const migrated = migrateApprovals(prevPatches, currentSnapshot, state.approved, state.denied);
    state.approved = migrated.approved;
    state.denied   = migrated.denied;
    state.revisions.push({ savedAt: new Date().toISOString(), patches: currentSnapshot });
    if (state.revisions.length > 10) state.revisions = state.revisions.slice(-10);
    scheduleAutoSave();
  }
}

// Returns [{hash, savedAt}] ordered oldest-to-newest for the given patch position.
// The last entry is always the current revision.
export function getRevisionList(patchIdx) {
  const seen = new Set();
  const list = [];
  for (const rev of state.revisions) {
    const p = rev.patches[patchIdx];
    if (p && !seen.has(p.hash)) {
      seen.add(p.hash);
      list.push({ hash: p.hash, savedAt: rev.savedAt });
    }
  }
  return list;
}

// Allow unit tests to import without a full browser environment.
if (typeof module !== 'undefined') {
  module.exports = { diffFingerprint, migrateApprovals, detectRevisionChanges, getRevisionList };
}

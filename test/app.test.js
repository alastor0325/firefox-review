'use strict';

// app.js uses browser globals; stub the minimum so the module loads cleanly.
global.document = { addEventListener: () => {} };
global.fetch = () => {};

const { diffFingerprint, migrateApprovals, submitReview, state } = require('../public/app');

// ── migrateApprovals ───────────────────────────────────────────────────────

describe('migrateApprovals', () => {
  function patches(...hashes) {
    return hashes.map((h) => ({ hash: h, message: '' }));
  }

  test('returns unchanged sets when no hashes changed', () => {
    const prev = patches('aaa', 'bbb');
    const curr = patches('aaa', 'bbb');
    const approved = new Set(['aaa']);
    const denied   = new Set(['bbb']);
    const result = migrateApprovals(prev, curr, approved, denied);
    expect([...result.approved]).toEqual(['aaa']);
    expect([...result.denied]).toEqual(['bbb']);
  });

  test('migrates approved hash when a patch is amended', () => {
    const prev = patches('old1', 'bbb');
    const curr = patches('new1', 'bbb');
    const approved = new Set(['old1']);
    const result = migrateApprovals(prev, curr, approved, new Set());
    expect(result.approved.has('new1')).toBe(true);
    expect(result.approved.has('old1')).toBe(false);
  });

  test('migrates denied hash when a patch is amended', () => {
    const prev = patches('aaa', 'old2');
    const curr = patches('aaa', 'new2');
    const denied = new Set(['old2']);
    const result = migrateApprovals(prev, curr, new Set(), denied);
    expect(result.denied.has('new2')).toBe(true);
    expect(result.denied.has('old2')).toBe(false);
  });

  test('migrates all amended patches in a series', () => {
    const prev = patches('p1old', 'p2old', 'p3old');
    const curr = patches('p1new', 'p2new', 'p3new');
    const approved = new Set(['p1old', 'p3old']);
    const denied   = new Set(['p2old']);
    const result = migrateApprovals(prev, curr, approved, denied);
    expect([...result.approved].sort()).toEqual(['p1new', 'p3new']);
    expect([...result.denied]).toEqual(['p2new']);
  });

  test('preserves unchanged hashes alongside migrated ones', () => {
    const prev = patches('keep', 'oldHash');
    const curr = patches('keep', 'newHash');
    const approved = new Set(['keep', 'oldHash']);
    const result = migrateApprovals(prev, curr, approved, new Set());
    expect(result.approved.has('keep')).toBe(true);
    expect(result.approved.has('newHash')).toBe(true);
    expect(result.approved.has('oldHash')).toBe(false);
  });

  test('does not mutate the original approved/denied sets', () => {
    const prev = patches('a');
    const curr = patches('b');
    const approved = new Set(['a']);
    const denied   = new Set();
    migrateApprovals(prev, curr, approved, denied);
    expect(approved.has('a')).toBe(true); // original unchanged
    expect(approved.has('b')).toBe(false);
  });

  test('handles patch list growing (new patch added at end)', () => {
    const prev = patches('aaa');
    const curr = patches('aaa', 'bbb');
    const approved = new Set(['aaa']);
    const result = migrateApprovals(prev, curr, approved, new Set());
    expect(result.approved.has('aaa')).toBe(true); // unchanged slot preserved
    expect(result.approved.has('bbb')).toBe(false); // new patch not auto-approved
  });

  test('handles patch list shrinking (patch removed from end)', () => {
    const prev = patches('aaa', 'bbb');
    const curr = patches('aaa');
    const approved = new Set(['aaa', 'bbb']);
    const result = migrateApprovals(prev, curr, approved, new Set());
    expect(result.approved.has('aaa')).toBe(true);
    // bbb is still in the set (it was approved; caller decides what to do with orphans)
    expect(result.approved.has('bbb')).toBe(true);
  });

  test('real-world: 7-patch series fully rebased, preserves approvals', () => {
    const oldHashes = ['4c121d73cc59', '54578b393e54', '1691a15381b6', '0638605bdac1',
                       '34a981659e03', '2384470bea8b', 'c9d2cb3e30a4'];
    const newHashes = ['8df262054527', '34bd29cbae3e', '066334383877', 'a788e32159d9',
                       '5d403cf94173', 'e21e480ba360', '1d37ab3f1e94'];
    const prev = patches(...oldHashes);
    const curr = patches(...newHashes);
    // Simulate: patches 0, 1, 2 were approved; patch 3 was denied
    const approved = new Set([oldHashes[0], oldHashes[1], oldHashes[2]]);
    const denied   = new Set([oldHashes[3]]);
    const result = migrateApprovals(prev, curr, approved, denied);
    expect(result.approved.has(newHashes[0])).toBe(true);
    expect(result.approved.has(newHashes[1])).toBe(true);
    expect(result.approved.has(newHashes[2])).toBe(true);
    expect(result.denied.has(newHashes[3])).toBe(true);
    // Old hashes gone
    oldHashes.forEach((h) => {
      expect(result.approved.has(h)).toBe(false);
      expect(result.denied.has(h)).toBe(false);
    });
  });
});

// ── diffFingerprint ────────────────────────────────────────────────────────

describe('diffFingerprint', () => {
  function makePatch(lines) {
    // lines: array of { type: 'added'|'removed'|'context', content: string }
    return { files: [{ hunks: [{ lines }] }] };
  }

  test('returns empty string for patch with no files', () => {
    expect(diffFingerprint({ files: [] })).toBe('');
  });

  test('excludes context lines', () => {
    const patch = makePatch([
      { type: 'context', content: 'unchanged' },
      { type: 'added',   content: 'new line'  },
    ]);
    expect(diffFingerprint(patch)).toBe('anew line');
  });

  test('includes added and removed lines with type prefix', () => {
    const patch = makePatch([
      { type: 'removed', content: 'old' },
      { type: 'added',   content: 'new' },
    ]);
    expect(diffFingerprint(patch)).toBe('rold\nanew');
  });

  test('same changed lines produce identical fingerprint', () => {
    const lines = [{ type: 'added', content: 'x' }];
    expect(diffFingerprint(makePatch(lines))).toBe(diffFingerprint(makePatch(lines)));
  });

  test('different changed lines produce different fingerprints', () => {
    const p1 = makePatch([{ type: 'added', content: 'foo' }]);
    const p2 = makePatch([{ type: 'added', content: 'bar' }]);
    expect(diffFingerprint(p1)).not.toBe(diffFingerprint(p2));
  });
});

// ── migrateApprovals — fingerprint-aware decisions ─────────────────────────

describe('migrateApprovals — fingerprint-aware', () => {
  function patch(hash, fp) {
    return fp !== undefined ? { hash, diffFingerprint: fp } : { hash };
  }

  test('same fingerprint, different hash → approved migrated to new hash', () => {
    const prev = [patch('old', 'fp1')];
    const curr = [patch('new', 'fp1')];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('new')).toBe(true);
    expect(result.approved.has('old')).toBe(false);
  });

  test('different fingerprint, different hash → approved cleared', () => {
    const prev = [patch('old', 'fp1')];
    const curr = [patch('new', 'fp2')];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('old')).toBe(false);
    expect(result.approved.has('new')).toBe(false);
  });

  test('different fingerprint → denied cleared too', () => {
    const prev = [patch('old', 'fp1')];
    const curr = [patch('new', 'fp2')];
    const result = migrateApprovals(prev, curr, new Set(), new Set(['old']));
    expect(result.denied.has('old')).toBe(false);
    expect(result.denied.has('new')).toBe(false);
  });

  test('no fingerprint on either side → falls back to hash migration', () => {
    const prev = [{ hash: 'old' }];
    const curr = [{ hash: 'new' }];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('new')).toBe(true);
    expect(result.approved.has('old')).toBe(false);
  });

  test('fingerprint absent on prev only → falls back to hash migration', () => {
    const prev = [{ hash: 'old' }];
    const curr = [patch('new', 'fp1')];
    const result = migrateApprovals(prev, curr, new Set(['old']), new Set());
    expect(result.approved.has('new')).toBe(true);
  });
});

// ── submitReview — approved preserved, denied/comments cleared ─────────────

describe('submitReview — state after submit', () => {
  let elements;

  function makeElement(overrides = {}) {
    return { textContent: '', value: '', classList: { add: jest.fn() }, dataset: {}, ...overrides };
  }

  beforeEach(() => {
    elements = {
      '#result-feedback-path': makeElement(),
      '#result-prompt':        makeElement(),
      '#result-overlay':       makeElement({ classList: { add: jest.fn() } }),
      '#btn-submit':           makeElement({ disabled: false }),
      '#btn-copy-prompt':      makeElement(),
      '#submit-warning':       makeElement(),
    };
    global.document = {
      addEventListener: () => {},
      querySelector: (sel) => elements[sel] || null,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ feedbackPath: '/fake/REVIEW_FEEDBACK.md', prompt: 'prompt text' }),
    });
    global.navigator = { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } };

    state.patches = [{ hash: 'abc123', message: 'fix: thing', files: [] }];
    state.approved = new Set(['abc123']);
    state.denied   = new Set(['def456']);
    state.comments = { abc123: { 'file.js': { L1: { text: 'nit' } } } };
    state.generalComments = { abc123: 'overall ok' };
  });

  afterEach(() => {
    global.document = { addEventListener: () => {} };
    delete global.navigator;
    state.patches = [];
    state.approved = new Set();
    state.denied   = new Set();
    state.comments = {};
    state.generalComments = {};
  });

  test('approved state is preserved after generating prompt', async () => {
    await submitReview();
    expect(state.approved.has('abc123')).toBe(true);
  });

  test('denied state is cleared after generating prompt', async () => {
    await submitReview();
    expect(state.denied.size).toBe(0);
  });

  test('comments and generalComments are cleared after generating prompt', async () => {
    await submitReview();
    expect(state.comments).toEqual({});
    expect(state.generalComments).toEqual({});
  });
});

// ── submitReview — auto-copy to clipboard ──────────────────────────────────

describe('submitReview clipboard auto-copy', () => {
  let elements;

  function makeElement(overrides = {}) {
    return { textContent: '', value: '', classList: { add: jest.fn() }, dataset: {}, ...overrides };
  }

  beforeEach(() => {
    elements = {
      '#result-feedback-path': makeElement(),
      '#result-prompt':        makeElement(),
      '#result-overlay':       makeElement({ classList: { add: jest.fn() } }),
      '#btn-submit':           makeElement({ disabled: false }),
      '#btn-copy-prompt':      makeElement(),
      '#submit-warning':       makeElement(),
    };

    global.document = {
      addEventListener: () => {},
      querySelector: (sel) => elements[sel] || null,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        feedbackPath: '/fake/REVIEW_FEEDBACK_bugABC.md',
        prompt: 'Please revise the following patches…',
      }),
    });

    global.navigator = {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    };
  });

  afterEach(() => {
    global.document = { addEventListener: () => {} };
    delete global.navigator;
  });

  test('copies the generated prompt to the clipboard automatically', async () => {
    await submitReview();
    expect(global.navigator.clipboard.writeText).toHaveBeenCalledWith(
      'Please revise the following patches…'
    );
  });

  test('sets btn-copy-prompt text to "Copied!" after auto-copy', async () => {
    jest.useFakeTimers();
    await submitReview();
    expect(elements['#btn-copy-prompt'].textContent).toBe('Copied!');
    jest.useRealTimers();
  });

  test('does not throw when clipboard access is denied', async () => {
    global.navigator.clipboard.writeText = jest.fn().mockRejectedValue(new Error('denied'));
    await expect(submitReview()).resolves.not.toThrow();
  });
});

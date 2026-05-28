/* @jest-environment jsdom */
'use strict';

// Verifies the client-side reconcile-on-reconnect contract (Task 4 of
// MULTI_TAB_SYNC_PLAN.md): when the SSE stream reconnects and the server's
// version doesn't match what we last saw, initStateChannel must emit a
// synthetic { kind: 'catchup' } delta so the app can fullRefresh.

// Stub EventSource to a controllable fake before importing persistence.
class FakeEventSource {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.last = this;
  }
  close() { FakeEventSource.closed = (FakeEventSource.closed || 0) + 1; }
  send(data) { if (this.onmessage) this.onmessage({ data: JSON.stringify(data) }); }
}
global.EventSource = FakeEventSource;
global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

const { initStateChannel, closeStateChannel } = require('../public/persistence');

beforeEach(() => {
  closeStateChannel();
  FakeEventSource.last = null;
  FakeEventSource.closed = 0;
});

test('first hello does not emit catchup', () => {
  const received = [];
  initStateChannel('wt', (d) => received.push(d));
  const es = FakeEventSource.last;
  es.send({ kind: 'hello', _version: 5 });
  expect(received).toEqual([]);
});

test('reconnect with matching version does not emit catchup', () => {
  const received = [];
  initStateChannel('wt', (d) => received.push(d));
  FakeEventSource.last.send({ kind: 'hello', _version: 5 });
  // Reconnect: same connection delivers another hello with same version.
  FakeEventSource.last.send({ kind: 'hello', _version: 5 });
  expect(received).toEqual([]);
});

test('reconnect with advanced version emits catchup', () => {
  const received = [];
  initStateChannel('wt', (d) => received.push(d));
  FakeEventSource.last.send({ kind: 'hello', _version: 5 });
  FakeEventSource.last.send({ kind: 'hello', _version: 9 });
  expect(received).toEqual([{ kind: 'catchup' }]);
});

test('reconnect after server restart (version rolls back to 0) emits catchup', () => {
  const received = [];
  initStateChannel('wt', (d) => received.push(d));
  FakeEventSource.last.send({ kind: 'hello', _version: 12 });
  FakeEventSource.last.send({ kind: 'hello', _version: 0 });
  expect(received).toEqual([{ kind: 'catchup' }]);
});

test('regular deltas are forwarded except those from this tab', () => {
  const received = [];
  initStateChannel('wt', (d) => received.push(d));
  FakeEventSource.last.send({ kind: 'hello', _version: 1 });
  FakeEventSource.last.send({ kind: 'comment', _from: 'other', _version: 2, patchHash: 'h' });
  // Note: we can't easily get TAB_ID inside the test, but a delta from
  // 'other' is clearly not us.
  expect(received).toHaveLength(1);
  expect(received[0].kind).toBe('comment');
});

test('worktree switch (closeStateChannel + reinit) treats new first hello as first', () => {
  const received = [];
  initStateChannel('wt', (d) => received.push(d));
  FakeEventSource.last.send({ kind: 'hello', _version: 7 });
  // Worktree switch: close, reopen.  The new connection is logically a
  // fresh start (different worktree's version space) — first hello must NOT
  // emit catchup even though the version differs.
  closeStateChannel();
  initStateChannel('wt2', (d) => received.push(d));
  FakeEventSource.last.send({ kind: 'hello', _version: 11 });
  expect(received).toEqual([]);
});

test('maybeCatchupOnVisible emits catchup after an SSE error, once', () => {
  const { maybeCatchupOnVisible } = require('../public/persistence');
  const received = [];
  initStateChannel('wt', (d) => received.push(d));
  FakeEventSource.last.send({ kind: 'hello', _version: 1 });

  // No disconnect observed yet → no catchup
  maybeCatchupOnVisible();
  expect(received).toEqual([]);

  // Simulate the SSE going into error state, then a visibility change
  FakeEventSource.last.onerror();
  maybeCatchupOnVisible();
  expect(received).toEqual([{ kind: 'catchup' }]);

  // Second visibility change should not re-emit until another error
  maybeCatchupOnVisible();
  expect(received).toEqual([{ kind: 'catchup' }]);
});

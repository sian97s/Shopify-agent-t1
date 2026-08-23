import { afterEach, describe, expect, it } from 'vitest';
import { makeHarness, type TestHarness } from './helpers.js';
import { SessionAuthError, SessionNotActiveError } from '../src/domain/upload-session/service.js';

let harness: TestHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

const start = (h: TestHarness) =>
  h.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });

describe('upload session lifecycle', () => {
  it('opens in processing and is live', () => {
    harness = makeHarness();
    const { session } = start(harness);
    expect(session.state).toBe('processing');
    expect(harness.ctx.sessions.isAbandoned(session)).toBe(false);
  });

  it('requires the session token, in constant time', () => {
    harness = makeHarness();
    const { session, token } = start(harness);
    expect(harness.ctx.sessions.authorise(session.id, token).id).toBe(session.id);
    expect(() => harness!.ctx.sessions.authorise(session.id, 'wrong')).toThrow(SessionAuthError);
    expect(() => harness!.ctx.sessions.authorise('no-such-session', token)).toThrow(SessionAuthError);
  });

  it('survives a short absence — phones suspend tabs', () => {
    harness = makeHarness({ graceMs: 90_000 });
    const { session } = start(harness);
    harness.clock.advance(80_000);
    expect(harness.ctx.sessions.isAbandoned(harness.ctx.sessions.get(session.id)!)).toBe(false);
    expect(harness.ctx.sessions.reap()).toHaveLength(0);
  });

  it('cancels a session abandoned beyond the grace window', () => {
    harness = makeHarness({ graceMs: 90_000 });
    const { session } = start(harness);
    harness.clock.advance(95_000);
    const cancelled = harness.ctx.sessions.reap();
    expect(cancelled).toHaveLength(1);
    expect(harness.ctx.sessions.get(session.id)!.state).toBe('cancelled');
    expect(harness.ctx.sessions.get(session.id)!.cancelReason).toBe('abandoned');
  });

  it('stays alive as long as heartbeats keep coming', () => {
    harness = makeHarness({ graceMs: 30_000, ttlMs: 600_000 });
    const { session } = start(harness);
    for (let i = 0; i < 10; i++) {
      harness.clock.advance(25_000);
      harness.ctx.sessions.heartbeat(session.id);
      expect(harness.ctx.sessions.reap()).toHaveLength(0);
    }
    expect(harness.ctx.sessions.get(session.id)!.state).toBe('processing');
  });

  it('expires at the hard TTL even while heartbeating', () => {
    harness = makeHarness({ graceMs: 60_000, ttlMs: 120_000 });
    const { session } = start(harness);
    harness.clock.advance(50_000);
    harness.ctx.sessions.heartbeat(session.id);
    harness.clock.advance(80_000);
    harness.ctx.sessions.heartbeat(session.id);
    const cancelled = harness.ctx.sessions.reap();
    expect(cancelled).toHaveLength(1);
    expect(harness.ctx.sessions.get(session.id)!.cancelReason).toBe('expired');
  });

  it('treats a dropped socket as nothing on its own', () => {
    harness = makeHarness({ graceMs: 90_000 });
    const { session } = start(harness);
    harness.ctx.sessions.connectionOpened(session.id);
    harness.ctx.sessions.connectionClosed(session.id);
    harness.clock.advance(10_000);
    expect(harness.ctx.sessions.reap()).toHaveLength(0);
    expect(harness.ctx.sessions.get(session.id)!.state).toBe('processing');
  });

  it('refuses to act on a session that already ended', () => {
    harness = makeHarness();
    const { session } = start(harness);
    harness.ctx.sessions.cancel(session.id, 'user_cancelled');
    const ended = harness.ctx.sessions.get(session.id)!;
    expect(ended.state).toBe('cancelled');
    expect(() => harness!.ctx.sessions.assertActive(ended)).toThrow(SessionNotActiveError);
  });

  it('cancels on assertActive when the grace window has already passed', () => {
    harness = makeHarness({ graceMs: 10_000 });
    const { session } = start(harness);
    harness.clock.advance(20_000);
    expect(() => harness!.ctx.sessions.assertActive(harness!.ctx.sessions.get(session.id)!)).toThrow(
      SessionNotActiveError
    );
    expect(harness.ctx.sessions.get(session.id)!.state).toBe('cancelled');
  });

  it('cannot be revived once terminal', () => {
    harness = makeHarness();
    const { session } = start(harness);
    harness.ctx.sessions.settle(session.id, 'rejected', { reason: 'unsafe_content' });
    expect(() => harness!.ctx.sessions.settle(session.id, 'approved')).toThrow();
    expect(() => harness!.ctx.sessions.settle(session.id, 'processing')).toThrow();
    expect(harness.ctx.sessions.get(session.id)!.state).toBe('rejected');
  });

  it('cancels every live session at boot — a session cannot survive a restart', () => {
    harness = makeHarness();
    const a = start(harness);
    const b = start(harness);
    harness.ctx.sessions.settle(b.session.id, 'needs_review');
    expect(harness.ctx.sessions.cancelAllLive('server_restart')).toBe(2);
    expect(harness.ctx.sessions.get(a.session.id)!.state).toBe('cancelled');
    expect(harness.ctx.sessions.get(b.session.id)!.state).toBe('cancelled');
    expect(harness.ctx.sessions.get(b.session.id)!.cancelReason).toBe('server_restart');
  });

  it('only offers live sessions to human review', () => {
    harness = makeHarness({ graceMs: 30_000 });
    const live = start(harness);
    const stale = start(harness);
    harness.ctx.sessions.settle(live.session.id, 'needs_review');
    harness.ctx.sessions.settle(stale.session.id, 'needs_review');
    harness.clock.advance(40_000);
    harness.ctx.sessions.heartbeat(live.session.id);
    const queue = harness.ctx.sessions.liveAwaitingReview();
    expect(queue.map((s) => s.id)).toEqual([live.session.id]);
  });

  it('notifies listeners on every state change', () => {
    harness = makeHarness();
    const seen: string[] = [];
    harness.ctx.sessions.onChange((s) => seen.push(s.state));
    const { session } = start(harness);
    harness.ctx.sessions.settle(session.id, 'needs_review');
    harness.ctx.sessions.settle(session.id, 'approved');
    expect(seen).toEqual(['processing', 'needs_review', 'approved']);
  });
});

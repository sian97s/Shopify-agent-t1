import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAiProvider, makeHarness, testImage, type TestHarness } from './helpers.js';

let harness: TestHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

describe('live moderation intake', () => {
  it('publishes an approved artwork and nothing else', async () => {
    harness = makeHarness();
    const { session } = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });
    const result = await harness.ctx.intake.submit(session, await testImage());

    expect(result.state).toBe('approved');
    expect(result.node).toBeDefined();
    expect(harness.ctx.artworks.countLive()).toBe(1);
    // All derivatives written, and the media path carries the public reference,
    // never an internal id.
    const keys = [...harness.storage.files.keys()];
    expect(keys).toContain(`art/${result.node!.ref}/thumb.webp`);
    expect(keys).toContain(`art/${result.node!.ref}/small.webp`);
    expect(keys).toContain(`art/${result.node!.ref}/large.webp`);
    expect(keys).toContain(`art/${result.node!.ref}/master.webp`);
  });

  it('publishes nothing when the creator leaves mid-moderation', async () => {
    harness = makeHarness({ ai: new FakeAiProvider({ delayMs: 20 }), graceMs: 1000 });
    const { session } = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });

    // The clock jumps past the grace window while the pipeline is running.
    const submission = harness.ctx.intake.submit(session, await testImage(), (stage) => {
      if (stage === 'ocr') harness!.clock.advance(60_000);
    });

    const result = await submission;
    expect(result.state).toBe('cancelled');
    expect(result.node).toBeUndefined();
    expect(harness.ctx.artworks.countLive()).toBe(0);
    expect(harness.ctx.sessions.get(session.id)!.state).toBe('cancelled');
    expect(harness.ctx.db.prepare('SELECT COUNT(*) AS n FROM art_keys').get()).toEqual({ n: 0 });
  });

  it('leaves no temporary copy behind, whatever the outcome', async () => {
    harness = makeHarness();
    const tmpDir = harness.ctx.config.tmpDir;

    const approved = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });
    await harness.ctx.intake.submit(approved.session, await testImage());

    const rejected = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });
    await harness.ctx.intake.submit(rejected.session, Buffer.from('nope'));

    const remaining = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    expect(remaining).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, `${approved.session.id}.bin`))).toBe(false);
  });

  it('holds borderline work for a human and publishes only if they approve in time', async () => {
    harness = makeHarness({ ai: new FakeAiProvider({ safety: { verdict: 'review' } }) });
    const { session } = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });

    const queued = await harness.ctx.intake.submit(session, await testImage());
    expect(queued.state).toBe('needs_review');
    expect(harness.ctx.artworks.countLive()).toBe(0);
    expect(harness.ctx.sessions.liveAwaitingReview()).toHaveLength(1);

    const approved = await harness.ctx.intake.review(session.id, true, 'admin');
    expect(approved.state).toBe('approved');
    expect(harness.ctx.artworks.countLive()).toBe(1);
  });

  it('never publishes a reviewed submission whose creator already left', async () => {
    harness = makeHarness({ ai: new FakeAiProvider({ safety: { verdict: 'review' } }), graceMs: 5_000 });
    const { session } = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });
    await harness.ctx.intake.submit(session, await testImage());

    harness.clock.advance(60_000);
    const late = await harness.ctx.intake.review(session.id, true, 'admin');

    expect(late.state).toBe('cancelled');
    expect(harness.ctx.artworks.countLive()).toBe(0);
    expect(harness.ctx.sessions.liveAwaitingReview()).toHaveLength(0);
  });

  it('rejects rather than publishes when a human says no', async () => {
    harness = makeHarness({ ai: new FakeAiProvider({ safety: { verdict: 'review' } }) });
    const { session } = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });
    await harness.ctx.intake.submit(session, await testImage());
    const outcome = await harness.ctx.intake.review(session.id, false, 'admin');
    expect(outcome.state).toBe('rejected');
    expect(harness.ctx.artworks.countLive()).toBe(0);
  });

  it('keeps a private artwork out of the public universe but inside its owner universe', async () => {
    harness = makeHarness();
    const { session } = harness.ctx.sessions.create({ artKeyId: null, visibility: 'private' });
    const result = await harness.ctx.intake.submit(session, await testImage());

    expect(result.state).toBe('approved');
    expect(harness.ctx.artworks.countLive()).toBe(0);
    const keyId = (await harness.ctx.artKeys.resolve(result.artKey!))!;
    expect(harness.ctx.artworks.ownedBy(keyId)).toHaveLength(1);
    // A private piece is searchable only inside its own partition.
    const search = harness.ctx.search.byText('test shapes');
    expect(search.candidates).toHaveLength(0);
  });

  it('connects a response to the artwork it answers, and lifts that piece', async () => {
    harness = makeHarness();
    const original = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });
    const first = await harness.ctx.intake.submit(original.session, await testImage());
    const parent = harness.ctx.artworks.byRef(first.node!.ref)!;
    const gravityBefore = parent.gravity;

    const answer = harness.ctx.sessions.create({
      artKeyId: null,
      visibility: 'universe',
      respondsTo: parent.id
    });
    const second = await harness.ctx.intake.submit(answer.session, await testImage());
    const child = harness.ctx.artworks.byRef(second.node!.ref)!;

    expect(child.respondsTo).toBe(parent.id);
    expect(second.node!.respondsTo).toBe(parent.publicRef);
    const edges = harness.ctx.relationships.neighbours(parent.id);
    expect(edges.some((e) => e.id === child.id && e.facet === 'response')).toBe(true);
    // A response is the strongest form of meaningful attention.
    expect(harness.ctx.artworks.byId(parent.id)!.gravity).toBeGreaterThan(gravityBefore);
  });

  it('refuses a second submission on a session that already finished', async () => {
    harness = makeHarness();
    const { session } = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });
    await harness.ctx.intake.submit(session, await testImage());
    expect(() => harness!.ctx.sessions.assertActive(harness!.ctx.sessions.get(session.id)!)).toThrow();
    expect(harness.ctx.artworks.countLive()).toBe(1);
  });
});

describe('visual gravity', () => {
  it('decays, so recent attention outweighs lifetime totals', () => {
    harness = makeHarness();
    const halfLife = harness.ctx.config.gravityHalfLifeMs;
    const now = harness.clock.now();
    expect(harness.ctx.gravity.decay(8, now, now)).toBeCloseTo(8, 5);
    expect(harness.ctx.gravity.decay(8, now, now + halfLife)).toBeCloseTo(4, 5);
    expect(harness.ctx.gravity.decay(8, now, now + halfLife * 4)).toBeCloseTo(0.5, 5);
  });

  it('compresses attention so nobody becomes a celebrity node', () => {
    harness = makeHarness();
    const now = harness.clock.now();
    const modest = harness.ctx.gravity.presentation(3, now, now);
    const enormous = harness.ctx.gravity.presentation(300, now, now);
    expect(enormous).toBeLessThan(1);
    expect(enormous - modest).toBeLessThan(0.7);
    expect(harness.ctx.gravity.band(modest)).not.toBe(harness.ctx.gravity.band(enormous));
  });

  it('weighs an artistic response far above a passive view', () => {
    harness = makeHarness();
    const now = harness.clock.now();
    const view = harness.ctx.gravity.presentation(0.02, now, now);
    const response = harness.ctx.gravity.presentation(1.0, now, now);
    expect(response / Math.max(view, 1e-6)).toBeGreaterThan(20);
  });
});

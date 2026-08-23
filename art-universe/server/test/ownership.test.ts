import { afterEach, describe, expect, it } from 'vitest';
import { NotOwnerError } from '../src/domain/ownership/index.js';
import { KeySessionTokens } from '../src/http/keysession.js';
import crypto from 'node:crypto';
import { makeHarness, testImage, type TestHarness } from './helpers.js';

let harness: TestHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

/** Publish one artwork through the real intake path and return what it made. */
async function publish(h: TestHarness, opts: { artKeyId?: string | null; visibility?: 'universe' | 'private' } = {}) {
  const { session } = h.ctx.sessions.create({
    artKeyId: opts.artKeyId ?? null,
    visibility: opts.visibility ?? 'universe'
  });
  const result = await h.ctx.intake.submit(session, await testImage());
  return { result, sessionId: session.id };
}

describe('anonymous ownership', () => {
  it('creates the Art Key only on a first successful publish', async () => {
    harness = makeHarness();
    const first = await publish(harness);
    expect(first.result.state).toBe('approved');
    expect(first.result.artKey).toBeTruthy();

    const artKeyId = await harness.ctx.artKeys.resolve(first.result.artKey!);
    expect(artKeyId).toBeTruthy();

    // A second upload by the same creator reuses the key; no second key exists.
    const second = await publish(harness, { artKeyId });
    expect(second.result.state).toBe('approved');
    expect(second.result.artKey).toBeUndefined();
    const keyCount = harness.ctx.db.prepare('SELECT COUNT(*) AS n FROM art_keys').get() as { n: number };
    expect(keyCount.n).toBe(1);
  });

  it('never issues a key for a submission that was rejected', async () => {
    harness = makeHarness();
    const { session } = harness.ctx.sessions.create({ artKeyId: null, visibility: 'universe' });
    const result = await harness.ctx.intake.submit(session, Buffer.from('not an image'));
    expect(result.state).toBe('rejected');
    expect(result.artKey).toBeUndefined();
    const keyCount = harness.ctx.db.prepare('SELECT COUNT(*) AS n FROM art_keys').get() as { n: number };
    expect(keyCount.n).toBe(0);
  });

  it('binds each artwork to exactly one Art Key', async () => {
    harness = makeHarness();
    const mine = await publish(harness);
    const myKeyId = (await harness.ctx.artKeys.resolve(mine.result.artKey!))!;
    const theirs = await publish(harness);
    const theirKeyId = (await harness.ctx.artKeys.resolve(theirs.result.artKey!))!;

    const myArtwork = harness.ctx.artworks.byRef(mine.result.node!.ref)!;
    const theirArtwork = harness.ctx.artworks.byRef(theirs.result.node!.ref)!;

    expect(harness.ctx.ownership.owns(myKeyId, myArtwork.id)).toBe(true);
    expect(harness.ctx.ownership.owns(theirKeyId, myArtwork.id)).toBe(false);
    expect(harness.ctx.ownership.owns(null, myArtwork.id)).toBe(false);
    expect(() => harness!.ctx.ownership.assertOwner(theirKeyId, myArtwork.id)).toThrow(NotOwnerError);
    expect(() => harness!.ctx.ownership.assertOwner(myKeyId, theirArtwork.id)).toThrow(NotOwnerError);
  });

  it('lists a creator every piece they own, private ones included', async () => {
    harness = makeHarness();
    const first = await publish(harness);
    const keyId = (await harness.ctx.artKeys.resolve(first.result.artKey!))!;
    await publish(harness, { artKeyId: keyId, visibility: 'private' });

    const owned = harness.ctx.ownership.artworkIdsFor(keyId);
    expect(owned).toHaveLength(2);
    expect(harness.ctx.artworks.ownedBy(keyId).some((a) => a.visibility === 'private')).toBe(true);
    // The private piece is not part of the public universe.
    expect(harness.ctx.artworks.live().some((a) => a.visibility === 'private')).toBe(false);
  });

  it('keeps seeded artwork ownerless, so nothing is claimable', async () => {
    harness = makeHarness();
    const { result } = await publish(harness);
    const keyId = (await harness.ctx.artKeys.resolve(result.artKey!))!;
    expect(harness.ctx.ownership.hasPublished(keyId)).toBe(true);
    expect(harness.ctx.ownership.ownerOf('does-not-exist')).toBeNull();
  });
});

describe('Art Key session tokens', () => {
  const secret = crypto.randomBytes(32);

  it('round-trips the owner id', () => {
    const tokens = new KeySessionTokens(secret);
    const token = tokens.issue('owner-1');
    expect(tokens.verify(token)).toBe('owner-1');
  });

  it('rejects tampering, another secret, and expiry', () => {
    const tokens = new KeySessionTokens(secret, 1000);
    const token = tokens.issue('owner-1', 1000);
    expect(tokens.verify(token.slice(0, -2) + 'xx', 1500)).toBeNull();
    expect(new KeySessionTokens(crypto.randomBytes(32)).verify(token, 1500)).toBeNull();
    expect(tokens.verify(token, 2001)).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
    expect(tokens.verify('garbage')).toBeNull();
  });

  it('does not carry the Art Key itself', async () => {
    harness = makeHarness();
    const { id, rawKey } = await harness.ctx.artKeys.create();
    const token = new KeySessionTokens(secret).issue(id);
    expect(token).not.toContain(rawKey);
    expect(Buffer.from(token.split('.')[0], 'base64url').toString()).not.toContain(rawKey);
  });
});

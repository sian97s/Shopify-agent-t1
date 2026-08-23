import { describe, expect, it, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { generateArtKey, looksLikeArtKey, normaliseArtKey, ART_KEY_ENTROPY_BITS } from '../src/domain/artkey/key.js';
import { blindIndex, hashArtKey, verifyArtKey } from '../src/domain/artkey/hashing.js';
import { makeHarness, TEST_KDF, type TestHarness } from './helpers.js';

let harness: TestHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

describe('Art Key generation', () => {
  it('produces the memorable shape plus an entropy segment', () => {
    const key = generateArtKey();
    expect(key).toMatch(/^[A-Z]+-[A-Z]+-\d{2}-[A-Z]+-[A-Z0-9]{6}$/);
    expect(looksLikeArtKey(key)).toBe(true);
  });

  it('carries enough entropy to be the only credential in the system', () => {
    expect(ART_KEY_ENTROPY_BITS).toBeGreaterThan(58);
  });

  it('does not repeat itself', () => {
    const keys = new Set(Array.from({ length: 400 }, () => generateArtKey()));
    expect(keys.size).toBe(400);
  });

  it('normalises what a person might realistically type', () => {
    const key = 'MOON-WHALE-73-KITE-K7QF9M';
    for (const variant of ['moon whale 73 kite k7qf9m', ' Moon-Whale-73-Kite-K7QF9M ', 'moon_whale_73_kite_k7qf9m']) {
      expect(normaliseArtKey(variant)).toBe(key);
    }
  });

  it('rejects obviously malformed input before any hashing happens', () => {
    for (const bad of ['', 'x', 'MOON', 'MOON-WHALE', '../../etc/passwd']) {
      expect(looksLikeArtKey(bad)).toBe(false);
    }
  });
});

describe('Art Key hashing', () => {
  it('verifies the right key and rejects the wrong one', async () => {
    const stored = await hashArtKey('MOON-WHALE-73-KITE-K7QF9M', TEST_KDF);
    await expect(verifyArtKey('MOON-WHALE-73-KITE-K7QF9M', stored)).resolves.toBe(true);
    await expect(verifyArtKey('MOON-WHALE-73-KITE-K7QF9N', stored)).resolves.toBe(false);
    await expect(verifyArtKey('', stored)).resolves.toBe(false);
  });

  it('uses a fresh salt per key, so identical keys hash differently', async () => {
    const a = await hashArtKey('SAME-KEY-11-HERE-ABCDEF', TEST_KDF);
    const b = await hashArtKey('SAME-KEY-11-HERE-ABCDEF', TEST_KDF);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    await expect(verifyArtKey('SAME-KEY-11-HERE-ABCDEF', a)).resolves.toBe(true);
    await expect(verifyArtKey('SAME-KEY-11-HERE-ABCDEF', b)).resolves.toBe(true);
  });

  it('records the KDF parameters it used', async () => {
    const stored = await hashArtKey('ANY-KEY-42-HERE-ZZZZZZ', TEST_KDF);
    expect(stored.kdf).toBe(`scrypt$N=${TEST_KDF.N},r=8,p=1,len=32`);
  });

  it('fails closed on tampered stored material rather than throwing', async () => {
    const stored = await hashArtKey('ANY-KEY-42-HERE-ZZZZZZ', TEST_KDF);
    await expect(verifyArtKey('ANY-KEY-42-HERE-ZZZZZZ', { ...stored, kdf: 'bcrypt$??' })).resolves.toBe(false);
    await expect(verifyArtKey('ANY-KEY-42-HERE-ZZZZZZ', { ...stored, hash: 'AAAA' })).resolves.toBe(false);
  });

  it('binds the blind index to the server pepper', () => {
    const key = 'MOON-WHALE-73-KITE-K7QF9M';
    const a = blindIndex(key, crypto.randomBytes(32));
    const b = blindIndex(key, crypto.randomBytes(32));
    expect(a).not.toBe(b);
    expect(a).not.toContain('MOON');
  });
});

describe('ArtKeyService', () => {
  it('resolves a key it issued, and nothing else', async () => {
    harness = makeHarness();
    const { id, rawKey } = await harness.ctx.artKeys.create();
    await expect(harness.ctx.artKeys.resolve(rawKey)).resolves.toBe(id);
    await expect(harness.ctx.artKeys.resolve(rawKey.toLowerCase().replace(/-/g, ' '))).resolves.toBe(id);
    await expect(harness.ctx.artKeys.resolve('MOON-WHALE-73-KITE-AAAAAA')).resolves.toBeNull();
    await expect(harness.ctx.artKeys.resolve('nonsense')).resolves.toBeNull();
  });

  it('never stores the raw key anywhere in the database', async () => {
    harness = makeHarness();
    const { rawKey } = await harness.ctx.artKeys.create();
    const rows = harness.ctx.db.prepare('SELECT * FROM art_keys').all();
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(rawKey);
    for (const segment of normaliseArtKey(rawKey).split('-')) {
      if (segment.length >= 4) expect(dump).not.toContain(segment);
    }
  });

  it('keeps two keys independent', async () => {
    harness = makeHarness();
    const a = await harness.ctx.artKeys.create();
    const b = await harness.ctx.artKeys.create();
    expect(a.id).not.toBe(b.id);
    await expect(harness.ctx.artKeys.resolve(a.rawKey)).resolves.toBe(a.id);
    await expect(harness.ctx.artKeys.resolve(b.rawKey)).resolves.toBe(b.id);
  });
});

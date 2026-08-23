import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../../infra/db.js';
import type { Clock } from '../../infra/clock.js';
import { systemClock } from '../../infra/clock.js';
import { internalId } from '../../infra/ids.js';
import { generateArtKey, looksLikeArtKey, normaliseArtKey } from './key.js';
import { blindIndex, DEFAULT_KDF, hashArtKey, verifyArtKey, type KdfParams } from './hashing.js';

export interface ArtKeyRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

/** Load or create the pepper used for the blind index. Never in the database. */
export function loadPepper(dataDir: string): Buffer {
  const file = path.join(dataDir, 'artkey.pepper');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const pepper = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, pepper, { mode: 0o600 });
  return pepper;
}

export class ArtKeyService {
  constructor(
    private db: Db,
    private pepper: Buffer,
    private clock: Clock = systemClock,
    private kdf: KdfParams = DEFAULT_KDF
  ) {}

  /**
   * Create a brand new Art Key. The raw key is returned exactly once, to the
   * creator, and is never written anywhere on the server.
   */
  async create(): Promise<{ id: string; rawKey: string }> {
    const rawKey = generateArtKey();
    const normalised = normaliseArtKey(rawKey);
    const material = await hashArtKey(normalised, this.kdf);
    const id = internalId();
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO art_keys (id, lookup, kdf, salt, key_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, blindIndex(normalised, this.pepper), material.kdf, material.salt, material.hash, now, now);
    return { id, rawKey };
  }

  /**
   * Resolve a raw key to its owner id, or null. Verification always runs the
   * slow KDF and a constant-time comparison; a missing row runs a decoy hash so
   * "no such key" and "wrong key" cost the same.
   */
  async resolve(rawKey: string): Promise<string | null> {
    if (!looksLikeArtKey(rawKey)) {
      await this.decoy();
      return null;
    }
    const normalised = normaliseArtKey(rawKey);
    const row = this.db
      .prepare(`SELECT id, kdf, salt, key_hash FROM art_keys WHERE lookup = ?`)
      .get(blindIndex(normalised, this.pepper)) as
      | { id: string; kdf: string; salt: string; key_hash: string }
      | undefined;

    if (!row) {
      await this.decoy();
      return null;
    }
    const ok = await verifyArtKey(normalised, {
      kdf: row.kdf,
      salt: row.salt,
      hash: row.key_hash
    });
    if (!ok) return null;
    this.db
      .prepare(`UPDATE art_keys SET last_seen_at = ? WHERE id = ?`)
      .run(this.clock.now(), row.id);
    return row.id;
  }

  private async decoy() {
    await hashArtKey('decoy-' + crypto.randomBytes(8).toString('hex'), this.kdf);
  }

  exists(id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM art_keys WHERE id = ?`).get(id);
  }
}

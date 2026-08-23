import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

export interface KdfParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/** ~100ms on a modern server; tests override this with cheap parameters. */
export const DEFAULT_KDF: KdfParams = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

export interface StoredKeyMaterial {
  kdf: string;
  salt: string;
  hash: string;
}

const encodeParams = (p: KdfParams) => `scrypt$N=${p.N},r=${p.r},p=${p.p},len=${p.keylen}`;

export function decodeParams(encoded: string): KdfParams {
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+),len=(\d+)$/.exec(encoded);
  if (!m) throw new Error(`unsupported kdf: ${encoded}`);
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), keylen: Number(m[4]) };
}

/** Hash a normalised Art Key with a fresh per-key salt. */
export async function hashArtKey(
  normalisedKey: string,
  params: KdfParams = DEFAULT_KDF
): Promise<StoredKeyMaterial> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(normalisedKey, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024
  });
  return {
    kdf: encodeParams(params),
    salt: salt.toString('base64'),
    hash: hash.toString('base64')
  };
}

/** Constant-time verification against stored material. */
export async function verifyArtKey(
  normalisedKey: string,
  stored: StoredKeyMaterial
): Promise<boolean> {
  let params: KdfParams;
  try {
    params = decodeParams(stored.kdf);
  } catch {
    return false;
  }
  const salt = Buffer.from(stored.salt, 'base64');
  const expected = Buffer.from(stored.hash, 'base64');
  let actual: Buffer;
  try {
    actual = await scrypt(normalisedKey, salt, params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 256 * 1024 * 1024
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) {
    // Still burn a comparison so failure timing does not depend on length.
    crypto.timingSafeEqual(actual, actual);
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Blind index. A slow KDF cannot be run against every row on every login, so
 * lookup goes through a keyed HMAC of the normalised key. The pepper lives
 * outside the database, and the raw key is still never stored.
 */
export function blindIndex(normalisedKey: string, pepper: Buffer): string {
  return crypto.createHmac('sha256', pepper).update(normalisedKey).digest('base64url');
}

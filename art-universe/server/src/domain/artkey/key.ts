import crypto from 'node:crypto';
import { KEY_WORDS } from './wordlist.js';

/** Alphabet for the entropy segment: no vowels, no look-alike characters. */
const TAIL_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const TAIL_LENGTH = 6;

/**
 * Art Key format: `MOON-WHALE-73-KITE-K7QF9M`.
 *
 * The first four segments are the memorable shape a person can write on paper.
 * They carry roughly 31 bits, which is not enough on its own for the only
 * credential in the system, so one short random segment is appended to bring
 * the key to ~61 bits. See README "Art Key entropy".
 */
export function generateArtKey(): string {
  const word = () => KEY_WORDS[crypto.randomInt(KEY_WORDS.length)];
  const tail = Array.from(
    { length: TAIL_LENGTH },
    () => TAIL_ALPHABET[crypto.randomInt(TAIL_ALPHABET.length)]
  ).join('');
  return [word(), word(), String(crypto.randomInt(10, 100)), word(), tail].join('-');
}

/**
 * Normalise anything a person might type or paste: lower case, spaces instead
 * of dashes, a stray trailing dot. Normalisation must be stable, because the
 * blind index is computed over the normalised form.
 */
export function normaliseArtKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Cheap shape check so obviously-malformed input never reaches the KDF. */
export function looksLikeArtKey(input: string): boolean {
  const n = normaliseArtKey(input);
  return /^[A-Z0-9]{2,12}(-[A-Z0-9]{1,12}){2,6}$/.test(n);
}

export const ART_KEY_ENTROPY_BITS =
  Math.log2(KEY_WORDS.length) * 3 + Math.log2(90) + Math.log2(TAIL_ALPHABET.length) * TAIL_LENGTH;

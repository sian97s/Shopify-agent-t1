import crypto from 'node:crypto';
import { SEMANTIC_DIM } from '../../infra/schema.js';
import { AXES, AXIS_INDEX, expand, type WeightedTerm } from './lexicon.js';

const AXIS_BLOCK = AXES.length;
const HASH_BLOCK = SEMANTIC_DIM - AXIS_BLOCK;

if (HASH_BLOCK < 64) throw new Error('semantic dimension too small for the concept axes');

const hashInt = (s: string, salt: string): number => {
  const h = crypto.createHash('sha1').update(salt).update(s).digest();
  return h.readUInt32BE(0);
};

/**
 * Concept encoder.
 *
 * The first block is one dimension per named concept axis, so a query term and
 * an artwork tag that mean the same thing land on exactly the same dimension.
 * The remaining block is a signed hashing-trick space that carries every other
 * word, so vocabulary outside the lexicon still contributes.
 */
export function encodeTerms(terms: WeightedTerm[]): Float32Array {
  const v = new Float32Array(SEMANTIC_DIM);
  for (const { term, weight } of terms) {
    const axis = AXIS_INDEX.get(term);
    if (axis !== undefined) v[axis] += weight * 1.6;
    const a = hashInt(term, 'a') % HASH_BLOCK;
    const b = hashInt(term, 'b') % HASH_BLOCK;
    const signA = hashInt(term, 'sa') % 2 ? 1 : -1;
    const signB = hashInt(term, 'sb') % 2 ? 1 : -1;
    v[AXIS_BLOCK + a] += weight * signA;
    v[AXIS_BLOCK + b] += weight * 0.7 * signB;
  }
  return normalise(v);
}

export function normalise(v: Float32Array): Float32Array {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag);
  if (mag === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= mag;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Weighted sum of already-normalised vectors, renormalised. */
export function blend(parts: { vector: Float32Array; weight: number }[]): Float32Array {
  const dim = parts[0]?.vector.length ?? SEMANTIC_DIM;
  const out = new Float32Array(dim);
  for (const { vector, weight } of parts) {
    for (let i = 0; i < dim; i++) out[i] += vector[i] * weight;
  }
  return normalise(out);
}

/** Natural-language query -> semantic vector. */
export const embedQuery = (query: string): Float32Array => encodeTerms(expand(query));

/**
 * Artwork -> semantic vector. Fields are weighted by how much they say about
 * what the piece *is*, rather than how it happens to be lit.
 */
export function embedArtwork(input: {
  caption?: string | null;
  tags?: string[];
  subject?: string | null;
  mood?: string | null;
  style?: string | null;
  medium?: string | null;
  descriptors?: string[];
  title?: string | null;
}): Float32Array {
  const terms: WeightedTerm[] = [];
  const push = (text: string | null | undefined, weight: number) => {
    if (text) terms.push(...expand(text, weight));
  };
  push(input.caption, 1);
  push(input.title, 0.7);
  push(input.subject, 1.5);
  push(input.mood, 1.3);
  push(input.style, 1.1);
  push(input.medium, 0.9);
  for (const tag of input.tags ?? []) push(tag, 1.2);
  for (const d of input.descriptors ?? []) push(d, 0.85);

  const merged = new Map<string, number>();
  for (const { term, weight } of terms) {
    merged.set(term, (merged.get(term) ?? 0) + weight);
  }
  return encodeTerms([...merged].map(([term, weight]) => ({ term, weight })));
}

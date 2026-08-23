import crypto from 'node:crypto';
import { SEMANTIC_DIM } from '../../infra/schema.js';

export const UNIVERSE_RADIUS = 7000;

/**
 * A fixed random projection from concept space to the plane.
 *
 * Positions are derived from meaning, so pieces that share subject, mood or
 * palette land near each other and clusters emerge on their own — no
 * force-directed graph, no per-frame layout cost, and the same artwork always
 * appears in the same place.
 */
function buildProjection(): [Float32Array, Float32Array] {
  const seed = crypto.createHash('sha256').update('art-universe/layout/v1').digest();
  const a = new Float32Array(SEMANTIC_DIM);
  const b = new Float32Array(SEMANTIC_DIM);
  let state = seed.readUInt32BE(0) || 1;
  const next = () => {
    // xorshift32 — deterministic across machines and runs.
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
  // Box-Muller for a gaussian projection: preserves distances far better than
  // uniform noise.
  for (let i = 0; i < SEMANTIC_DIM; i++) {
    const u1 = Math.max(next(), 1e-9);
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    a[i] = r * Math.cos(2 * Math.PI * u2);
    b[i] = r * Math.sin(2 * Math.PI * u2);
  }
  return [a, b];
}

const [PX, PY] = buildProjection();

export function positionFor(
  semantic: Float32Array,
  opts: { jitterSeed?: string; near?: { x: number; y: number } } = {}
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let i = 0; i < SEMANTIC_DIM; i++) {
    x += semantic[i] * PX[i];
    y += semantic[i] * PY[i];
  }
  // The projection of a unit vector is roughly gaussian with sd ~1.
  const scale = UNIVERSE_RADIUS / 3.2;
  x *= scale;
  y *= scale;

  if (opts.jitterSeed) {
    const h = crypto.createHash('sha256').update(opts.jitterSeed).digest();
    // Enough scatter that pieces sharing a subject form a constellation rather
    // than a stack, while the cluster itself still reads as one region.
    x += (h.readUInt16BE(0) / 65535 - 0.5) * 1500;
    y += (h.readUInt16BE(2) / 65535 - 0.5) * 1500;
  }

  if (opts.near) {
    // A response belongs beside the artwork it answers: keep it in the parent's
    // neighbourhood while letting its own meaning tilt the direction.
    const angle = Math.atan2(y - opts.near.y, x - opts.near.x);
    const radius = 210 + Math.random() * 150;
    x = opts.near.x + Math.cos(angle) * radius;
    y = opts.near.y + Math.sin(angle) * radius;
  }

  return { x, y };
}

/** Nudge apart pieces that landed on top of each other. */
export function separate(
  points: { id: string; x: number; y: number }[],
  minDistance = 320,
  iterations = 10
): void {
  const cell = minDistance * 2;
  for (let iter = 0; iter < iterations; iter++) {
    const grid = new Map<string, typeof points>();
    for (const p of points) {
      const key = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(p);
      else grid.set(key, [p]);
    }
    let moved = false;
    for (const p of points) {
      const gx = Math.floor(p.x / cell);
      const gy = Math.floor(p.y / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const q of grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
            if (q === p) continue;
            const ddx = q.x - p.x;
            const ddy = q.y - p.y;
            const d = Math.hypot(ddx, ddy);
            if (d >= minDistance || d === 0) continue;
            const push = (minDistance - d) / 2;
            const ux = ddx / d;
            const uy = ddy / d;
            p.x -= ux * push; p.y -= uy * push;
            q.x += ux * push; q.y += uy * push;
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
}

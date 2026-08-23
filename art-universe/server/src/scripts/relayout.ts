import { createContext } from '../context.js';
import { positionFor, separate } from '../domain/artwork/layout.js';

/**
 * Recompute every artwork's position from its embedding.
 *
 * Positions are derived, not authored, so the layout can be tuned and replayed
 * over an existing universe without touching the artwork itself.
 */
function main() {
  const ctx = createContext();
  const all = ctx.artworks.live();
  const points: { id: string; x: number; y: number }[] = [];

  for (const artwork of all) {
    const semantic = ctx.artworks.embedding('vec_semantic', artwork.id);
    if (!semantic) continue;
    const parent = artwork.respondsTo ? ctx.artworks.byId(artwork.respondsTo) : null;
    const position = positionFor(semantic, {
      jitterSeed: artwork.id,
      near: parent ? { x: parent.x, y: parent.y } : undefined
    });
    points.push({ id: artwork.id, ...position });
  }

  separate(points, 330, 16);
  for (const p of points) ctx.artworks.setPosition(p.id, p.x, p.y);
  console.log(`Repositioned ${points.length} artworks.`);
}

main();

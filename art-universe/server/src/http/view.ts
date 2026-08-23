import type { AppContext } from '../context.js';
import type { ArtworkRecord } from '../domain/artwork/types.js';
import { toNode } from '../domain/artwork/present.js';
import type { UniverseView } from '../../../shared/types.js';

/** Build the payload the renderer consumes: nodes plus the few lines worth drawing. */
export function buildView(
  ctx: AppContext,
  records: ArtworkRecord[],
  opts: { focus?: { x: number; y: number; zoom?: number } | null; context: string; edgesPerNode?: number }
): UniverseView {
  const refOf = (id: string) => ctx.artworks.byId(id)?.publicRef ?? null;
  const nodes = records.map((r) =>
    toNode(r, { storage: ctx.storage, gravity: ctx.gravity, refOf })
  );
  const refById = new Map(records.map((r) => [r.id, r.publicRef]));
  const edges = ctx.relationships.edgesFor(
    records.map((r) => r.id),
    refById,
    opts.edgesPerNode ?? 3
  );
  return { nodes, edges, focus: opts.focus ?? null, context: opts.context };
}

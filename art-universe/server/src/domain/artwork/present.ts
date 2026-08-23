import type { UniverseNode } from '../../../../shared/types.js';
import type { ObjectStorage } from '../../services/storage/index.js';
import type { GravityService } from '../gravity/index.js';
import type { ArtworkRecord } from './types.js';

/**
 * The only place an artwork becomes something the browser can see. Internal
 * ids, moderation history, owner keys, captions and counts stop here.
 */
export function toNode(
  a: ArtworkRecord,
  deps: { storage: ObjectStorage; gravity: GravityService; refOf: (id: string) => string | null },
  now?: number
): UniverseNode {
  const presentation = deps.gravity.presentation(a.gravity, a.gravityAt, now);
  return {
    ref: a.publicRef,
    title: a.title,
    aspect: a.width / a.height,
    palette: a.palette,
    x: a.x,
    y: a.y,
    gravity: Number(presentation.toFixed(3)),
    band: deps.gravity.band(presentation),
    media: {
      thumb: deps.storage.url(`${a.storageKey}/thumb.webp`),
      small: deps.storage.url(`${a.storageKey}/small.webp`),
      large: deps.storage.url(`${a.storageKey}/large.webp`)
    },
    respondsTo: a.respondsTo ? deps.refOf(a.respondsTo) : null,
    visibility: a.visibility
  };
}

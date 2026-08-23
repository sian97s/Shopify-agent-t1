import sharp from 'sharp';
import { createContext } from '../context.js';
import { prepareImage, DERIVATIVES } from '../services/images/processor.js';
import { embedArtwork } from '../services/ai/embeddings.js';
import { positionFor, separate } from '../domain/artwork/layout.js';
import { internalId, publicRef } from '../infra/ids.js';
import { generatePiece, THEMES } from './generative.js';

/**
 * Seed the universe.
 *
 * Seeded pieces go through exactly the same image pipeline, embedding and
 * relationship discovery as an uploaded artwork — only the semantic reading is
 * known up front instead of inferred, because we drew them.
 */
async function main() {
  const perTheme = Number(process.argv[2] ?? 13);
  const ctx = createContext();

  if (ctx.artworks.countLive() > 0 && !process.argv.includes('--force')) {
    console.log(`Universe already has ${ctx.artworks.countLive()} artworks. Pass --force to add more.`);
    return;
  }

  const created: { id: string; x: number; y: number }[] = [];
  const byTheme = new Map<string, string[]>();
  let n = 0;

  for (const theme of THEMES) {
    for (let i = 0; i < perTheme; i++) {
      const piece = generatePiece(theme, `v1-${i}`);
      const png = await sharp(Buffer.from(piece.svg)).png().toBuffer();
      const prepared = await prepareImage(png);

      const id = internalId();
      let ref = publicRef();
      while (ctx.artworks.byRef(ref)) ref = publicRef();
      const storageKey = `art/${ref}`;

      await ctx.storage.put(`${storageKey}/master.webp`, prepared.master, 'image/webp');
      for (const d of DERIVATIVES) {
        await ctx.storage.put(`${storageKey}/${d.name}.webp`, prepared.derivatives[d.name], 'image/webp');
      }

      const semantic = embedArtwork({
        caption: piece.meta.caption,
        tags: piece.meta.tags,
        subject: piece.meta.subject,
        mood: piece.meta.mood,
        style: piece.meta.style,
        medium: piece.meta.medium,
        descriptors: prepared.features.descriptors,
        title: piece.meta.title
      });
      const position = positionFor(semantic, { jitterSeed: id });

      // Spread creation times across the last few weeks so freshness and decay
      // have something real to work with from the first minute.
      const createdAt = Date.now() - Math.floor(Math.random() * 40 * 86400_000);

      ctx.artworks.insert({
        id,
        publicRef: ref,
        artKeyId: null,
        visibility: 'universe',
        title: piece.meta.title,
        titleSource: piece.meta.title ? 'creator' : null,
        width: prepared.width,
        height: prepared.height,
        palette: prepared.features.palette,
        caption: piece.meta.caption,
        tags: piece.meta.tags,
        mood: piece.meta.mood,
        style: piece.meta.style,
        medium: piece.meta.medium,
        subject: piece.meta.subject,
        storageKey,
        x: position.x,
        y: position.y,
        respondsTo: null,
        seeded: true,
        createdAt
      });
      ctx.artworks.saveEmbeddings(id, 'universe', semantic, prepared.features.embedding);
      created.push({ id, ...position });
      byTheme.set(theme, [...(byTheme.get(theme) ?? []), id]);
      n++;
      if (n % 10 === 0) process.stdout.write(`  ${n} pieces\r`);
    }
  }

  // Keep pieces from stacking exactly on top of each other.
  separate(created, 330, 14);
  for (const p of created) ctx.artworks.setPosition(p.id, p.x, p.y);

  // A few artistic responses, so branching visual conversations exist on day one.
  const responders: [string, string][] = [];
  for (const [, ids] of byTheme) {
    for (let i = 0; i + 1 < ids.length; i += 5) responders.push([ids[i + 1], ids[i]]);
  }
  for (const [child, parent] of responders.slice(0, 24)) {
    const p = ctx.artworks.byId(parent)!;
    ctx.db.prepare(`UPDATE artworks SET responds_to = ? WHERE id = ?`).run(parent, child);
    const pos = positionFor(ctx.artworks.embedding('vec_semantic', child)!, {
      jitterSeed: child,
      near: { x: p.x, y: p.y }
    });
    ctx.artworks.setPosition(child, pos.x, pos.y);
  }

  // Relationships last, once every embedding is in place.
  for (const { id } of created) {
    const semantic = ctx.artworks.embedding('vec_semantic', id)!;
    const visual = ctx.artworks.embedding('vec_visual', id)!;
    ctx.artworks.saveEmbeddings(id, 'universe', semantic, visual);
    const record = ctx.artworks.byId(id)!;
    ctx.relationships.computeFor(id, semantic, visual, record.respondsTo);
  }

  // A little uneven attention, so Visual Gravity reads as a real difference.
  for (const { id } of created) {
    const rolls = Math.floor(Math.random() ** 3 * 9);
    for (let i = 0; i < rolls; i++) {
      ctx.gravity.record(id, Math.random() < 0.25 ? 'inspired' : Math.random() < 0.5 ? 'appreciate' : 'explore_related');
    }
  }

  console.log(`Seeded ${n} artworks across ${THEMES.length} kinds of work.`);
  console.log(`Universe now holds ${ctx.artworks.countLive()} pieces.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

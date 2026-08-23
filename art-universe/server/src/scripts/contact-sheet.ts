import sharp from 'sharp';
import { generatePiece, THEMES } from './generative.js';

/** Dev helper: render one of every kind of seed piece into a single sheet. */
async function main() {
  const out = process.argv[2] ?? 'seed-grid.png';
  const tiles: Buffer[] = [];
  for (const t of THEMES) {
    const p = generatePiece(t, 'v1-0');
    tiles.push(await sharp(Buffer.from(p.svg)).resize(300, 220, { fit: 'cover' }).png().toBuffer());
  }
  const cols = 5;
  const rows = Math.ceil(tiles.length / cols);
  await sharp({ create: { width: cols * 300, height: rows * 220, channels: 3, background: '#05060c' } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * 300, top: Math.floor(i / cols) * 220 })))
    .png()
    .toFile(out);
  console.log(`wrote ${out}`);
}
main();

import sharp from 'sharp';
import { generatePiece } from './generative.js';

/** Dev helper: write one generated piece to disk, to exercise the upload flow. */
const out = process.argv[2] ?? 'sample-art.jpg';
const theme = process.argv[3] ?? 'insect';
const piece = generatePiece(theme, process.argv[4] ?? 'sample');
sharp(Buffer.from(piece.svg))
  .jpeg({ quality: 88 })
  .toFile(out)
  .then(() => console.log(`wrote ${out}`));

import { VISUAL_DIM } from '../../infra/schema.js';

export interface VisualFeatures {
  /** L2-normalised visual embedding (colour, composition, texture). */
  embedding: Float32Array;
  /** Dominant colours as hex, most prominent first. */
  palette: string[];
  /** Human-readable colour/lighting words, fed to the semantic layer. */
  descriptors: string[];
  brightness: number;
  saturation: number;
  colorfulness: number;
  contrast: number;
  edgeDensity: number;
  warmth: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const f = (c: number) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
  const [R, G, B] = [f(r), f(g), f(b)];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.9505;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.089;
  const g2 = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [g2(X), g2(Y), g2(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const hex = (r: number, g: number, b: number) =>
  '#' +
  [r, g, b]
    .map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0'))
    .join('');

/**
 * Extract a palette by bucketing pixels in a coarse RGB grid and merging the
 * heaviest buckets. Cheap, deterministic, and good enough to paint a node
 * before its image has loaded.
 */
function extractPalette(pixels: Uint8Array, count = 5): { hexes: string[]; shares: number[] } {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key);
    if (cur) {
      cur.n++; cur.r += r; cur.g += g; cur.b += b;
    } else {
      buckets.set(key, { n: 1, r, g, b });
    }
  }
  const total = pixels.length / 3;
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const chosen: { r: number; g: number; b: number; n: number }[] = [];
  for (const c of sorted) {
    const avg = { r: c.r / c.n / 255, g: c.g / c.n / 255, b: c.b / c.n / 255, n: c.n };
    // Skip near-duplicates so the palette stays legible.
    const dupe = chosen.some(
      (p) => Math.abs(p.r - avg.r) + Math.abs(p.g - avg.g) + Math.abs(p.b - avg.b) < 0.18
    );
    if (!dupe) chosen.push(avg);
    if (chosen.length >= count) break;
  }
  while (chosen.length < count && chosen.length > 0) chosen.push(chosen[chosen.length - 1]);
  return {
    hexes: chosen.map((c) => hex(c.r, c.g, c.b)),
    shares: chosen.map((c) => c.n / total)
  };
}

function colourWords(h: number, s: number, v: number): string[] {
  const words: string[] = [];
  if (s < 0.12) words.push(v < 0.3 ? 'black' : v > 0.8 ? 'white' : 'grey');
  else {
    const deg = h * 360;
    if (deg < 15 || deg >= 345) words.push('red');
    else if (deg < 40) words.push('orange');
    else if (deg < 68) words.push('yellow');
    else if (deg < 160) words.push('green');
    else if (deg < 200) words.push('teal');
    else if (deg < 250) words.push('blue');
    else if (deg < 290) words.push('purple');
    else if (deg < 330) words.push('magenta');
    else words.push('pink');
  }
  return words;
}

/**
 * Build the visual embedding from raw RGB pixels of a small square resize.
 * Blocks are individually weighted, then the whole vector is L2-normalised so
 * cosine similarity behaves.
 */
export function computeVisualFeatures(rgb: Buffer, size: number, aspect: number): VisualFeatures {
  const px = new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.length);
  const n = size * size;

  const hueHist = new Float32Array(24);
  const satHist = new Float32Array(8);
  const valHist = new Float32Array(8);
  const lumGrid = new Float32Array(16);
  const satGrid = new Float32Array(16);
  const edgeGrid = new Float32Array(16);
  const gridN = new Float32Array(16);
  const quadHue = new Float32Array(8); // cos/sin per quadrant
  const quadN = new Float32Array(4);

  let sumL = 0, sumL2 = 0, sumS = 0, sumWarm = 0, sumCool = 0;
  let sumRG = 0, sumRG2 = 0, sumYB = 0, sumYB2 = 0;
  const lum = new Float32Array(n);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const [h, s, v] = rgbToHsv(r, g, b);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum[y * size + x] = l;

      const w = s * v;
      hueHist[Math.min(23, Math.floor(h * 24))] += w;
      satHist[Math.min(7, Math.floor(s * 8))] += 1;
      valHist[Math.min(7, Math.floor(v * 8))] += 1;

      const gx = Math.min(3, Math.floor((x / size) * 4));
      const gy = Math.min(3, Math.floor((y / size) * 4));
      const gi = gy * 4 + gx;
      lumGrid[gi] += l; satGrid[gi] += s; gridN[gi] += 1;

      const qi = (y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1);
      quadHue[qi * 2] += Math.cos(h * Math.PI * 2) * w;
      quadHue[qi * 2 + 1] += Math.sin(h * Math.PI * 2) * w;
      quadN[qi] += 1;

      sumL += l; sumL2 += l * l; sumS += s;
      sumWarm += (r - b) > 0 ? (r - b) * s : 0;
      sumCool += (b - r) > 0 ? (b - r) * s : 0;
      const rg = r - g, yb = 0.5 * (r + g) - b;
      sumRG += rg; sumRG2 += rg * rg; sumYB += yb; sumYB2 += yb * yb;
    }
  }

  // Sobel-ish edge energy per grid cell.
  let edgeTotal = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const gxv = lum[y * size + x + 1] - lum[y * size + x - 1];
      const gyv = lum[(y + 1) * size + x] - lum[(y - 1) * size + x];
      const e = Math.hypot(gxv, gyv);
      edgeTotal += e;
      const gx = Math.min(3, Math.floor((x / size) * 4));
      const gy = Math.min(3, Math.floor((y / size) * 4));
      edgeGrid[gy * 4 + gx] += e;
    }
  }

  const mean = sumL / n;
  const variance = Math.max(0, sumL2 / n - mean * mean);
  const contrast = Math.sqrt(variance) * 2;
  const meanSat = sumS / n;
  const stdRG = Math.sqrt(Math.max(0, sumRG2 / n - (sumRG / n) ** 2));
  const stdYB = Math.sqrt(Math.max(0, sumYB2 / n - (sumYB / n) ** 2));
  const colorfulness = clamp01(
    (Math.sqrt(stdRG ** 2 + stdYB ** 2) + 0.3 * Math.hypot(sumRG / n, sumYB / n)) * 2
  );
  const edgeDensity = clamp01((edgeTotal / n) * 6);
  const warmth = clamp01((sumWarm - sumCool) / n + 0.5);

  // Symmetry: correlation between an image and its mirror.
  let symH = 0, symV = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size / 2; x++) {
      symH += Math.abs(lum[y * size + x] - lum[y * size + (size - 1 - x)]);
    }
  }
  for (let y = 0; y < size / 2; y++) {
    for (let x = 0; x < size; x++) {
      symV += Math.abs(lum[y * size + x] - lum[(size - 1 - y) * size + x]);
    }
  }
  symH = 1 - clamp01((symH / (n / 2)) * 2);
  symV = 1 - clamp01((symV / (n / 2)) * 2);

  // Luminance entropy — busy vs. calm images.
  let entropy = 0;
  for (let i = 0; i < 8; i++) {
    const p = valHist[i] / n;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  entropy /= 3;

  let centre = 0, border = 0, cn = 0, bn = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inner = x > size * 0.25 && x < size * 0.75 && y > size * 0.25 && y < size * 0.75;
      if (inner) { centre += lum[y * size + x]; cn++; } else { border += lum[y * size + x]; bn++; }
    }
  }
  const centreBias = clamp01((centre / cn - border / bn) + 0.5);

  const norm = (arr: Float32Array, by?: Float32Array) => {
    const out = new Float32Array(arr.length);
    let total = 0;
    for (let i = 0; i < arr.length; i++) total += by ? 0 : arr[i];
    for (let i = 0; i < arr.length; i++) {
      out[i] = by ? (by[i] ? arr[i] / by[i] : 0) : total > 0 ? arr[i] / total : 0;
    }
    return out;
  };

  const gridNorm = (arr: Float32Array) => norm(arr, gridN);
  const hueN = norm(hueHist);
  const satN = norm(satHist);
  const valN = norm(valHist);
  const lumG = gridNorm(lumGrid);
  const satG = gridNorm(satGrid);
  const edgeG = (() => {
    const out = new Float32Array(16);
    let max = 0;
    for (let i = 0; i < 16; i++) max = Math.max(max, edgeGrid[i]);
    for (let i = 0; i < 16; i++) out[i] = max > 0 ? edgeGrid[i] / max : 0;
    return out;
  })();
  const quadN2 = new Float32Array(8);
  for (let q = 0; q < 4; q++) {
    const c = quadN[q] || 1;
    quadN2[q * 2] = quadHue[q * 2] / c;
    quadN2[q * 2 + 1] = quadHue[q * 2 + 1] / c;
  }

  const { hexes, shares } = extractPalette(px, 5);
  const labs = hexes.flatMap((h) => {
    const r = parseInt(h.slice(1, 3), 16) / 255;
    const g = parseInt(h.slice(3, 5), 16) / 255;
    const b = parseInt(h.slice(5, 7), 16) / 255;
    const [L, A, B] = rgbToLab(r, g, b);
    return [L / 100, A / 128, B / 128];
  });

  const parts: { values: ArrayLike<number>; weight: number }[] = [
    { values: hueN, weight: 1.4 },          // 24
    { values: satN, weight: 0.8 },          // 8
    { values: valN, weight: 0.8 },          // 8
    { values: labs, weight: 1.2 },          // 15
    { values: lumG, weight: 1.0 },          // 16
    { values: satG, weight: 0.8 },          // 16
    { values: edgeG, weight: 0.7 },         // 16
    { values: quadN2, weight: 0.6 },        // 8
    {
      values: [
        clamp01(Math.log2(aspect) / 2 + 0.5), contrast, colorfulness, mean, edgeDensity,
        symH, symV, warmth, 1 - warmth, 1 - mean, mean, meanSat,
        centreBias, entropy, shares[0] ?? 0, shares[1] ?? 0, clamp01(stdRG * 3)
      ],
      weight: 0.9
    } // 17
  ];

  const embedding = new Float32Array(VISUAL_DIM);
  let k = 0;
  for (const part of parts) {
    for (let i = 0; i < part.values.length && k < VISUAL_DIM; i++) {
      embedding[k++] = part.values[i] * part.weight;
    }
  }
  if (k !== VISUAL_DIM) {
    throw new Error(`visual feature block mismatch: produced ${k}, expected ${VISUAL_DIM}`);
  }
  let mag = 0;
  for (let i = 0; i < VISUAL_DIM; i++) mag += embedding[i] * embedding[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < VISUAL_DIM; i++) embedding[i] /= mag;

  const descriptors = new Set<string>();
  hexes.slice(0, 3).forEach((h) => {
    const r = parseInt(h.slice(1, 3), 16) / 255;
    const g = parseInt(h.slice(3, 5), 16) / 255;
    const b = parseInt(h.slice(5, 7), 16) / 255;
    const [hh, ss, vv] = rgbToHsv(r, g, b);
    colourWords(hh, ss, vv).forEach((w) => descriptors.add(w));
  });
  if (mean < 0.3) descriptors.add('dark');
  if (mean > 0.72) descriptors.add('bright');
  if (meanSat > 0.55) descriptors.add('vivid');
  if (meanSat < 0.2) descriptors.add('muted');
  if (contrast > 0.55) descriptors.add('high-contrast');
  if (edgeDensity > 0.55) descriptors.add('detailed');
  if (edgeDensity < 0.22) descriptors.add('smooth');
  if (warmth > 0.62) descriptors.add('warm');
  if (warmth < 0.38) descriptors.add('cool');
  if (symH > 0.7) descriptors.add('symmetrical');

  return {
    embedding,
    palette: hexes,
    descriptors: [...descriptors],
    brightness: mean,
    saturation: meanSat,
    colorfulness,
    contrast,
    edgeDensity,
    warmth
  };
}

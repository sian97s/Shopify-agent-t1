import { greyscaleRaw } from '../images/processor.js';
import type {
  AiProvider, AnalysisInput, OcrResult, SafetyResult, SemanticAnalysis
} from './types.js';

/**
 * The offline provider. It runs with no network and no API key, and is what
 * keeps the whole app usable (and testable) by itself.
 *
 * It is honest about its limits: `safety()` reports `degraded: true` because a
 * pixel heuristic cannot judge whether an image is hateful or exploitative.
 * What it *can* do for real — machine-readable codes, dense-text detection,
 * colour/composition reading — it does.
 */
export class LocalAiProvider implements AiProvider {
  readonly name = 'local';

  async analyse(input: AnalysisInput): Promise<SemanticAnalysis> {
    const f = input.features;
    const tags = new Set<string>(f.descriptors);

    const mood = pickMood(f.brightness, f.saturation, f.contrast, f.edgeDensity, f.warmth);
    const style = f.edgeDensity > 0.55
      ? 'detailed'
      : f.contrast > 0.6
        ? 'graphic'
        : f.edgeDensity < 0.2
          ? 'minimal'
          : 'organic';
    tags.add(mood);
    tags.add(style);
    tags.add('abstract');

    const colourWords = f.palette.length ? f.descriptors.slice(0, 3).join(', ') : 'colour';
    const caption =
      `${cap(mood)} ${style} composition in ${colourWords}, ` +
      `${f.brightness < 0.35 ? 'low light' : f.brightness > 0.7 ? 'bright light' : 'even light'}.`;

    return {
      caption,
      tags: [...tags].slice(0, 12),
      subject: null,
      mood,
      style,
      medium: null,
      suggestedTitle: `${cap(mood)} ${cap(f.descriptors[0] ?? 'Field')}`
    };
  }

  async ocr(input: AnalysisInput): Promise<OcrResult> {
    const { data, width, height } = await greyscaleRaw(input.image, 256);
    const bands = textBandScore(data, width, height);
    const codes = detectCodeMarkers(data, width, height);
    return {
      hasText: bands > 0.42,
      text: '',
      confidence: bands,
      codes
    };
  }

  async safety(_input: AnalysisInput, ocr: OcrResult): Promise<SafetyResult> {
    const categories: string[] = [];
    if (ocr.codes.length) categories.push('machine_readable_code');
    if (ocr.hasText && ocr.confidence > 0.62) categories.push('dense_text');

    // A code that could redirect somewhere unverifiable always goes to a human.
    const verdict: SafetyResult['verdict'] = categories.includes('machine_readable_code')
      ? 'review'
      : 'safe';

    return { verdict, categories, confidence: 0.35, degraded: true };
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function pickMood(
  brightness: number, saturation: number, contrast: number, edges: number, warmth: number
): string {
  if (brightness < 0.3 && saturation < 0.3) return edges > 0.45 ? 'eerie' : 'lonely';
  if (brightness < 0.36 && contrast > 0.55) return 'mysterious';
  if (saturation > 0.6 && edges > 0.5) return 'energetic';
  if (saturation > 0.55 && warmth > 0.6) return 'joyful';
  if (edges < 0.24 && saturation < 0.35) return 'peaceful';
  if (edges < 0.3 && brightness > 0.6) return 'dreamy';
  if (contrast > 0.62) return 'tense';
  if (warmth < 0.4) return 'melancholy';
  return 'playful';
}

/**
 * Rendered text produces rows with many short dark/light runs, repeated in
 * horizontal bands with quiet gaps between them. That signature is quite
 * distinct from painted or photographed content.
 */
function textBandScore(data: Buffer, width: number, height: number): number {
  const rowScores = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let transitions = 0;
    let prev = data[y * width] > 128;
    let runs = 0;
    let run = 0;
    for (let x = 1; x < width; x++) {
      const cur = data[y * width + x] > 128;
      run++;
      if (cur !== prev) {
        transitions++;
        if (run <= Math.max(2, width / 40)) runs++;
        run = 0;
        prev = cur;
      }
    }
    // Many transitions, most of them short: characteristic of glyphs.
    rowScores[y] = transitions > 8 ? Math.min(1, (runs / Math.max(transitions, 1)) * (transitions / 30)) : 0;
  }
  // Text appears in bands, so reward contiguous runs of high-scoring rows.
  let best = 0;
  let acc = 0;
  let bandRows = 0;
  for (let y = 0; y < height; y++) {
    if (rowScores[y] > 0.3) {
      acc += rowScores[y];
      bandRows++;
      best = Math.max(best, acc / Math.max(4, bandRows) * Math.min(1, bandRows / 6));
    } else {
      acc = 0;
      bandRows = 0;
    }
  }
  return Math.min(1, best);
}

/**
 * QR finder patterns are three concentric squares whose scanline signature is
 * a 1:1:3:1:1 run-length ratio. Finding two or more of them is strong evidence
 * of a machine-readable code — which, per the safety scope, must not be
 * published without a human look.
 */
function detectCodeMarkers(
  data: Buffer, width: number, height: number
): { kind: string; note: string }[] {
  let hits = 0;
  for (let y = 0; y < height; y += 2) {
    const runs: { dark: boolean; len: number }[] = [];
    let prev = data[y * width] < 110;
    let len = 1;
    for (let x = 1; x < width; x++) {
      const dark = data[y * width + x] < 110;
      if (dark === prev) len++;
      else {
        runs.push({ dark: prev, len });
        prev = dark;
        len = 1;
      }
    }
    runs.push({ dark: prev, len });
    for (let i = 0; i + 4 < runs.length; i++) {
      const w = runs.slice(i, i + 5);
      if (!w[0].dark || w[1].dark || !w[2].dark || w[3].dark || !w[4].dark) continue;
      const unit = (w[0].len + w[1].len + w[3].len + w[4].len) / 4;
      if (unit < 1.5) continue;
      const ok =
        near(w[0].len, unit) && near(w[1].len, unit) &&
        near(w[2].len, unit * 3, 0.55) && near(w[3].len, unit) && near(w[4].len, unit);
      if (ok) hits++;
    }
  }
  return hits >= 6
    ? [{ kind: 'qr_like', note: `${hits} finder-pattern scanlines` }]
    : [];
}

const near = (v: number, target: number, tol = 0.5) => Math.abs(v - target) <= target * tol;

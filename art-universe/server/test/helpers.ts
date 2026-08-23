import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDb } from '../src/infra/db.js';
import { createContext, type AppContext } from '../src/context.js';
import { ManualClock } from '../src/infra/clock.js';
import type { ObjectStorage } from '../src/services/storage/index.js';
import type { AiProvider, AnalysisInput, OcrResult, SafetyResult, SemanticAnalysis } from '../src/services/ai/types.js';
import { generatePiece } from '../src/scripts/generative.js';

/** Cheap KDF parameters: the security property under test is the algorithm, not the cost. */
export const TEST_KDF = { N: 1 << 10, r: 8, p: 1, keylen: 32 };

export class MemoryStorage implements ObjectStorage {
  files = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.files.set(key, body);
  }
  async get(key: string) {
    const file = this.files.get(key);
    if (!file) throw new Error(`missing ${key}`);
    return file;
  }
  async remove(prefix: string) {
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }
  url(key: string) {
    return `/media/${key}`;
  }
}

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  constructor(
    public plan: {
      safety?: Partial<SafetyResult>;
      ocr?: Partial<OcrResult>;
      analysis?: Partial<SemanticAnalysis>;
      delayMs?: number;
    } = {}
  ) {}

  private async delay() {
    if (this.plan.delayMs) await new Promise((r) => setTimeout(r, this.plan.delayMs));
  }

  async analyse(_input: AnalysisInput): Promise<SemanticAnalysis> {
    await this.delay();
    return {
      caption: 'a test artwork',
      tags: ['test', 'blue'],
      subject: 'test shapes',
      mood: 'peaceful',
      style: 'abstract',
      medium: 'digital',
      suggestedTitle: 'Quiet Test',
      ...this.plan.analysis
    };
  }

  async ocr(): Promise<OcrResult> {
    await this.delay();
    return { hasText: false, text: '', confidence: 0.1, codes: [], ...this.plan.ocr };
  }

  async safety(): Promise<SafetyResult> {
    await this.delay();
    return { verdict: 'safe', categories: [], confidence: 0.9, degraded: false, ...this.plan.safety };
  }
}

export interface TestHarness {
  ctx: AppContext;
  clock: ManualClock;
  storage: MemoryStorage;
  dataDir: string;
  cleanup(): void;
}

export function makeHarness(
  opts: { ai?: AiProvider; ttlMs?: number; graceMs?: number } = {}
): TestHarness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-universe-test-'));
  const clock = new ManualClock(1_700_000_000_000);
  const storage = new MemoryStorage();
  const ctx = createContext({
    db: openDb(':memory:'),
    clock,
    storage,
    ai: opts.ai ?? new FakeAiProvider(),
    kdf: TEST_KDF,
    config: {
      dataDir,
      tmpDir: path.join(dataDir, 'tmp'),
      mediaDir: path.join(dataDir, 'media'),
      uploadSessionTtlMs: opts.ttlMs ?? 600_000,
      uploadSessionGraceMs: opts.graceMs ?? 90_000
    }
  });
  return {
    ctx,
    clock,
    storage,
    dataDir,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true })
  };
}

let cachedImage: Buffer | null = null;

/** A real image, so the image pipeline under test is the real one. */
export async function testImage(): Promise<Buffer> {
  if (cachedImage) return cachedImage;
  const piece = generatePiece('geometric', 'test-1');
  cachedImage = await sharp(Buffer.from(piece.svg)).resize(360).png().toBuffer();
  return cachedImage;
}

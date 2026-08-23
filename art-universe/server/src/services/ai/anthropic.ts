import crypto from 'node:crypto';
import { LocalAiProvider } from './local.js';
import type {
  AiProvider, AnalysisInput, OcrResult, SafetyResult, SemanticAnalysis
} from './types.js';

interface VisionReading {
  caption: string;
  tags: string[];
  subject: string | null;
  mood: string | null;
  style: string | null;
  medium: string | null;
  suggested_title: string | null;
  text_in_image: string;
  codes: { kind: string; note: string }[];
  safety: { verdict: 'safe' | 'review' | 'unsafe'; categories: string[]; confidence: number };
}

const SYSTEM = `You read a single artwork for an anonymous art platform and reply with one JSON object and nothing else.

Describe what is actually depicted, in plain words a person searching would use.

Then screen it. Reject ("unsafe") ONLY for: explicit sexual content, sexual content involving minors or any exploitative content, graphic gore, extreme real violence, hate imagery, credible threats, clearly illegal material, targeted harassment, or malicious spam.

Send to "review" (never straight to unsafe) when the image is borderline, when it carries machine-readable codes, visible personal contact information, or when you are unsure.

Never mark art unsafe merely for being sad, political, religious, frightening, anatomical, nude in a non-explicit artistic sense, dark, strange, disturbing, emotionally difficult, or surreal. Difficult art is still art.

JSON shape:
{"caption": string, "tags": string[] (5-12 lowercase single words),
 "subject": string|null, "mood": string|null, "style": string|null, "medium": string|null,
 "suggested_title": string|null (max 4 words, evocative, never a description of the medium),
 "text_in_image": string (verbatim text visible in the image, "" if none),
 "codes": [{"kind": string, "note": string}] (QR codes, barcodes, scannable markers),
 "safety": {"verdict": "safe"|"review"|"unsafe", "categories": string[], "confidence": number}}`;

/**
 * Claude-backed analysis. One vision call produces the semantic reading, the
 * OCR text and the safety verdict together — the pipeline stages then read
 * from that single result, so a moderation run costs one request.
 */
export class AnthropicAiProvider implements AiProvider {
  readonly name = 'anthropic';
  private fallback = new LocalAiProvider();
  private cache = new Map<string, Promise<VisionReading | null>>();

  constructor(
    private apiKey: string,
    private model: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  private read(input: AnalysisInput): Promise<VisionReading | null> {
    const key = crypto.createHash('sha256').update(input.image).digest('hex');
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.call(input).catch(() => null);
      this.cache.set(key, pending);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value as string);
    }
    return pending;
  }

  private async call(input: AnalysisInput): Promise<VisionReading | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 900,
          system: SYSTEM,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: input.image.toString('base64')
                  }
                },
                { type: 'text', text: 'Read this artwork.' }
              ]
            }
          ]
        })
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = body.content?.find((c) => c.type === 'text')?.text ?? '';
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json) as VisionReading;
      if (!parsed || typeof parsed.caption !== 'string') return null;
      return parsed;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async analyse(input: AnalysisInput): Promise<SemanticAnalysis> {
    const r = await this.read(input);
    if (!r) return this.fallback.analyse(input);
    const local = await this.fallback.analyse(input);
    return {
      caption: r.caption,
      // Keep the measured colour/lighting words: they make colour queries work.
      tags: [...new Set([...(r.tags ?? []), ...input.features.descriptors])].slice(0, 16),
      subject: r.subject ?? null,
      mood: r.mood ?? local.mood,
      style: r.style ?? local.style,
      medium: r.medium ?? null,
      suggestedTitle: r.suggested_title ?? local.suggestedTitle
    };
  }

  async ocr(input: AnalysisInput): Promise<OcrResult> {
    const r = await this.read(input);
    if (!r) return this.fallback.ocr(input);
    const localCodes = await this.fallback.ocr(input);
    const text = r.text_in_image ?? '';
    return {
      hasText: text.trim().length > 0,
      text,
      confidence: 0.9,
      codes: [...(r.codes ?? []), ...localCodes.codes]
    };
  }

  async safety(input: AnalysisInput, ocr: OcrResult): Promise<SafetyResult> {
    const r = await this.read(input);
    if (!r?.safety) return this.fallback.safety(input, ocr);
    const categories = [...(r.safety.categories ?? [])];
    if (ocr.codes.length) categories.push('machine_readable_code');
    let verdict = r.safety.verdict;
    if (verdict === 'safe' && ocr.codes.length) verdict = 'review';
    return {
      verdict,
      categories,
      confidence: typeof r.safety.confidence === 'number' ? r.safety.confidence : 0.7,
      degraded: false
    };
  }
}

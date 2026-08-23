import type { VisualFeatures } from '../images/features.js';

export interface AnalysisInput {
  /** Small JPEG suitable for a vision model. */
  image: Buffer;
  features: VisualFeatures;
  width: number;
  height: number;
}

export interface SemanticAnalysis {
  caption: string;
  tags: string[];
  subject: string | null;
  mood: string | null;
  style: string | null;
  medium: string | null;
  suggestedTitle: string | null;
}

export interface OcrResult {
  /** True when the image very likely contains rendered text. */
  hasText: boolean;
  /** Recognised text, empty when the provider can only detect presence. */
  text: string;
  confidence: number;
  /** Machine-readable codes found in the image (QR/barcode finder patterns). */
  codes: { kind: string; note: string }[];
}

export type SafetyVerdict = 'safe' | 'review' | 'unsafe';

export interface SafetyResult {
  verdict: SafetyVerdict;
  /** Policy categories that fired. Internal only. */
  categories: string[];
  confidence: number;
  /** True when the provider could not do a real content judgement. */
  degraded: boolean;
}

export interface PiiResult {
  found: boolean;
  kinds: string[];
}

export interface AiProvider {
  readonly name: string;
  analyse(input: AnalysisInput): Promise<SemanticAnalysis>;
  ocr(input: AnalysisInput): Promise<OcrResult>;
  safety(input: AnalysisInput, ocr: OcrResult): Promise<SafetyResult>;
}

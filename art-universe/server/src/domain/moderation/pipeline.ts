import type { PublicRejectionReason, Visibility } from '../../../../shared/types.js';
import { prepareImage, analysisImage, UnsupportedImageError, type PreparedImage } from '../../services/images/processor.js';
import { detectPii } from '../../services/ai/pii.js';
import { embedArtwork } from '../../services/ai/embeddings.js';
import type { AiProvider, OcrResult, SafetyResult, SemanticAnalysis } from '../../services/ai/types.js';

export interface PipelineCheck {
  name: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

export interface PipelineOutcome {
  decision: 'approved' | 'needs_review' | 'rejected';
  reason: PublicRejectionReason | null;
  checks: PipelineCheck[];
  prepared: PreparedImage | null;
  analysis: SemanticAnalysis | null;
  semantic: Float32Array | null;
  visual: Float32Array | null;
  /** Internal only — never shown to the creator. */
  notes: string[];
}

export class SubmissionCancelled extends Error {
  constructor() {
    super('upload session ended before moderation finished');
    this.name = 'SubmissionCancelled';
  }
}

/**
 * The live moderation pipeline:
 *
 *   temporary processing -> metadata removal -> OCR -> personal-information
 *   detection -> content-safety -> semantic analysis -> embeddings -> decision
 *
 * It never publishes anything itself, and it checks between every stage that
 * the upload session is still alive. If the creator left, the run aborts and
 * nothing is written.
 */
export class ModerationPipeline {
  constructor(private ai: AiProvider) {}

  async run(
    file: Buffer,
    opts: { visibility: Visibility; stillAlive: () => boolean; onStage?: (stage: string) => void }
  ): Promise<PipelineOutcome> {
    const checks: PipelineCheck[] = [];
    const notes: string[] = [];

    const guard = () => {
      if (!opts.stillAlive()) throw new SubmissionCancelled();
    };

    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      guard();
      opts.onStage?.(name);
      const started = Date.now();
      try {
        const value = await fn();
        checks.push({ name, ok: true, ms: Date.now() - started });
        return value;
      } catch (err) {
        checks.push({
          name,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          ms: Date.now() - started
        });
        throw err;
      }
    };

    const fail = (reason: PublicRejectionReason): PipelineOutcome => ({
      decision: 'rejected', reason, checks, prepared: null, analysis: null,
      semantic: null, visual: null, notes
    });

    let prepared: PreparedImage;
    try {
      prepared = await step('prepare', () => prepareImage(file));
    } catch (err) {
      if (err instanceof SubmissionCancelled) throw err;
      if (err instanceof UnsupportedImageError) return fail('unsupported_image');
      notes.push(`prepare failed: ${(err as Error).message}`);
      return fail('could_not_verify');
    }
    if (prepared.strippedMetadata.length) {
      notes.push(`removed metadata: ${prepared.strippedMetadata.join(',')}`);
    }
    if (prepared.adjustments.length) notes.push(`adjusted: ${prepared.adjustments.join(',')}`);

    const input = {
      image: await analysisImage(prepared.master),
      features: prepared.features,
      width: prepared.width,
      height: prepared.height
    };

    let ocr: OcrResult;
    let safety: SafetyResult;
    let analysis: SemanticAnalysis;
    try {
      ocr = await step('ocr', () => this.ai.ocr(input));
      const pii = await step('personal_information', async () => detectPii(ocr.text));
      safety = await step('content_safety', () => this.ai.safety(input, ocr));
      analysis = await step('semantic_analysis', () => this.ai.analyse(input));

      if (pii.found) notes.push(`personal information: ${pii.kinds.join(',')}`);
      if (ocr.codes.length) notes.push(`codes: ${ocr.codes.map((c) => c.kind).join(',')}`);
      if (safety.categories.length) notes.push(`safety: ${safety.categories.join(',')}`);

      const semantic = embedArtwork({
        caption: analysis.caption,
        tags: analysis.tags,
        subject: analysis.subject,
        mood: analysis.mood,
        style: analysis.style,
        medium: analysis.medium,
        descriptors: prepared.features.descriptors
      });

      const decision = decide({
        visibility: opts.visibility,
        safety,
        ocr,
        piiFound: pii.found
      });

      return {
        ...decision,
        checks,
        prepared,
        analysis,
        semantic,
        visual: prepared.features.embedding,
        notes
      };
    } catch (err) {
      if (err instanceof SubmissionCancelled) throw err;
      notes.push(`screening failed: ${(err as Error).message}`);
      return fail('could_not_verify');
    }
  }
}

/**
 * Decision policy, isolated so it can be read and argued with in one place.
 *
 * Borderline work goes to review, never to a blunt rejection. Private artwork
 * takes a lighter path — but still gets the security scanning, because a QR
 * code or someone else's phone number is a problem either way.
 */
export function decide(input: {
  visibility: Visibility;
  safety: SafetyResult;
  ocr: OcrResult;
  piiFound: boolean;
}): { decision: 'approved' | 'needs_review' | 'rejected'; reason: PublicRejectionReason | null } {
  const { visibility, safety, ocr, piiFound } = input;

  if (safety.verdict === 'unsafe') return { decision: 'rejected', reason: 'unsafe_content' };

  if (piiFound) {
    // Contact information in a private piece is the creator's own business;
    // in the universe it is a safety problem.
    return visibility === 'universe'
      ? { decision: 'rejected', reason: 'personal_information' }
      : { decision: 'approved', reason: null };
  }

  if (ocr.codes.length) {
    // A scannable code can redirect anywhere. Public codes need a human.
    return visibility === 'universe'
      ? { decision: 'needs_review', reason: null }
      : { decision: 'approved', reason: null };
  }

  if (visibility === 'private') return { decision: 'approved', reason: null };

  if (safety.verdict === 'review') return { decision: 'needs_review', reason: null };

  return { decision: 'approved', reason: null };
}

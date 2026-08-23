import { afterEach, describe, expect, it } from 'vitest';
import {
  canTransition, InvalidTransitionError, isTerminal, transition, TRANSITIONS
} from '../src/domain/moderation/state-machine.js';
import { decide, ModerationPipeline, SubmissionCancelled } from '../src/domain/moderation/pipeline.js';
import { FakeAiProvider, makeHarness, testImage, type TestHarness } from './helpers.js';
import type { ModerationState } from '../../shared/types.js';

let harness: TestHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

const ALL: ModerationState[] = ['processing', 'approved', 'needs_review', 'rejected', 'cancelled'];

describe('moderation state machine', () => {
  it('allows only the transitions the product permits', () => {
    expect(TRANSITIONS.processing).toEqual(['approved', 'needs_review', 'rejected', 'cancelled']);
    expect(TRANSITIONS.needs_review).toEqual(['approved', 'rejected', 'cancelled']);
    expect(TRANSITIONS.approved).toEqual([]);
    expect(TRANSITIONS.rejected).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
  });

  it('treats approved, rejected and cancelled as terminal', () => {
    expect(isTerminal('approved')).toBe(true);
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('processing')).toBe(false);
    expect(isTerminal('needs_review')).toBe(false);
  });

  it('never lets a terminal submission re-enter the pipeline', () => {
    for (const from of ['approved', 'rejected', 'cancelled'] as ModerationState[]) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(false);
        expect(() => transition(from, to)).toThrow(InvalidTransitionError);
      }
    }
  });

  it('lets a live submission reach every decision', () => {
    expect(transition('processing', 'approved')).toBe('approved');
    expect(transition('processing', 'needs_review')).toBe('needs_review');
    expect(transition('needs_review', 'approved')).toBe('approved');
    expect(transition('needs_review', 'cancelled')).toBe('cancelled');
  });
});

describe('decision policy', () => {
  const base = {
    safety: { verdict: 'safe' as const, categories: [], confidence: 0.9, degraded: false },
    ocr: { hasText: false, text: '', confidence: 0, codes: [] },
    piiFound: false
  };

  it('rejects unsafe content outright', () => {
    expect(decide({ ...base, visibility: 'universe', safety: { ...base.safety, verdict: 'unsafe' } }))
      .toEqual({ decision: 'rejected', reason: 'unsafe_content' });
  });

  it('sends borderline work to review rather than rejecting it', () => {
    expect(decide({ ...base, visibility: 'universe', safety: { ...base.safety, verdict: 'review' } }))
      .toEqual({ decision: 'needs_review', reason: null });
  });

  it('rejects public artwork carrying personal information', () => {
    expect(decide({ ...base, visibility: 'universe', piiFound: true }))
      .toEqual({ decision: 'rejected', reason: 'personal_information' });
  });

  it("lets a private piece keep the creator's own contact details", () => {
    expect(decide({ ...base, visibility: 'private', piiFound: true }))
      .toEqual({ decision: 'approved', reason: null });
  });

  it('always sends a public scannable code to a human', () => {
    const withCode = { ...base, ocr: { ...base.ocr, codes: [{ kind: 'qr_like', note: '' }] } };
    expect(decide({ ...withCode, visibility: 'universe' }))
      .toEqual({ decision: 'needs_review', reason: null });
  });

  it('still refuses unsafe content on the lighter private path', () => {
    expect(decide({ ...base, visibility: 'private', safety: { ...base.safety, verdict: 'unsafe' } }))
      .toEqual({ decision: 'rejected', reason: 'unsafe_content' });
  });

  it('approves ordinary public art', () => {
    expect(decide({ ...base, visibility: 'universe' })).toEqual({ decision: 'approved', reason: null });
  });
});

describe('moderation pipeline', () => {
  it('strips metadata, analyses, embeds and approves', async () => {
    const pipeline = new ModerationPipeline(new FakeAiProvider());
    const outcome = await pipeline.run(await testImage(), {
      visibility: 'universe',
      stillAlive: () => true
    });
    expect(outcome.decision).toBe('approved');
    expect(outcome.prepared).not.toBeNull();
    expect(outcome.semantic).not.toBeNull();
    expect(outcome.visual).not.toBeNull();
    expect(outcome.checks.map((c) => c.name)).toEqual([
      'prepare', 'ocr', 'personal_information', 'content_safety', 'semantic_analysis'
    ]);
    expect(outcome.checks.every((c) => c.ok)).toBe(true);
  });

  it('rejects an unreadable image as unsupported', async () => {
    const pipeline = new ModerationPipeline(new FakeAiProvider());
    const outcome = await pipeline.run(Buffer.from('this is not an image'), {
      visibility: 'universe',
      stillAlive: () => true
    });
    expect(outcome.decision).toBe('rejected');
    expect(outcome.reason).toBe('unsupported_image');
  });

  it('aborts the moment the upload session dies', async () => {
    const pipeline = new ModerationPipeline(new FakeAiProvider({ delayMs: 5 }));
    let alive = true;
    const run = pipeline.run(await testImage(), {
      visibility: 'universe',
      stillAlive: () => alive,
      onStage: (stage) => {
        if (stage === 'ocr') alive = false;
      }
    });
    await expect(run).rejects.toBeInstanceOf(SubmissionCancelled);
  });

  it('rejects rather than guesses when screening fails', async () => {
    const failing = new FakeAiProvider();
    failing.safety = async () => {
      throw new Error('provider down');
    };
    const outcome = await new ModerationPipeline(failing).run(await testImage(), {
      visibility: 'universe',
      stillAlive: () => true
    });
    expect(outcome.decision).toBe('rejected');
    expect(outcome.reason).toBe('could_not_verify');
  });

  it('records that EXIF was removed before publication', async () => {
    harness = makeHarness();
    const outcome = await new ModerationPipeline(new FakeAiProvider()).run(await testImage(), {
      visibility: 'universe',
      stillAlive: () => true
    });
    // The generated PNG carries no EXIF, but the pipeline must always report
    // what it found and produce a metadata-free master.
    expect(outcome.prepared!.strippedMetadata).toBeDefined();
    const { default: sharp } = await import('sharp');
    const meta = await sharp(outcome.prepared!.master).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });
});

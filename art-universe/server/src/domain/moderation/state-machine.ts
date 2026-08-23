import type { ModerationState } from '../../../../shared/types.js';

export class InvalidTransitionError extends Error {
  constructor(from: ModerationState, to: ModerationState) {
    super(`illegal moderation transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * The moderation state machine, kept pure so it can be reasoned about and
 * tested on its own.
 *
 *   processing ──> approved      (terminal: the artwork is published)
 *              ├─> needs_review  (still live; a human may still decide)
 *              ├─> rejected      (terminal)
 *              └─> cancelled     (terminal: session died or was abandoned)
 *
 *   needs_review ──> approved | rejected | cancelled
 *
 * `approved`, `rejected` and `cancelled` are terminal. There is deliberately no
 * path from a terminal state back into the pipeline: nothing may be revived and
 * silently published after the upload session has ended (§8).
 */
export const TRANSITIONS: Record<ModerationState, ModerationState[]> = {
  processing: ['approved', 'needs_review', 'rejected', 'cancelled'],
  needs_review: ['approved', 'rejected', 'cancelled'],
  approved: [],
  rejected: [],
  cancelled: []
};

export const TERMINAL_STATES: ModerationState[] = ['approved', 'rejected', 'cancelled'];

export const isTerminal = (state: ModerationState): boolean => TERMINAL_STATES.includes(state);

export const canTransition = (from: ModerationState, to: ModerationState): boolean =>
  TRANSITIONS[from]?.includes(to) ?? false;

export function transition(from: ModerationState, to: ModerationState): ModerationState {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

/** States in which the upload session must still be kept alive. */
export const isLive = (state: ModerationState): boolean => !isTerminal(state);

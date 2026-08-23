/**
 * Types shared between the server and the browser client.
 * Nothing in here may leak internal identifiers, moderation internals or
 * anything that could be turned into a public metric (Constitution 7, 13).
 */

export type Visibility = 'universe' | 'private';

/** Coarse presentation bands. Never an exact number. (Constitution 7/17) */
export type GravityBand = 'quiet' | 'stirring' | 'discovered' | 'luminous';

export interface UniverseNode {
  /** Public reference, e.g. "7K3P9X". The internal id is never sent. */
  ref: string;
  title: string | null;
  /** Aspect ratio of the source artwork. */
  aspect: number;
  /** Dominant colours, used for far-zoom rendering before any image loads. */
  palette: string[];
  /** Position in universe space. */
  x: number;
  y: number;
  /** 0..1 presentation weight — glow, particles, line richness. Never shown as a number. */
  gravity: number;
  band: GravityBand;
  media: { thumb: string; small: string; large: string };
  /** Public ref of the artwork this one is a response to, if any. */
  respondsTo: string | null;
  visibility: Visibility;
}

export type RelationKind = 'similarity' | 'response';

export interface UniverseEdge {
  a: string;
  b: string;
  kind: RelationKind;
  strength: number;
}

export interface UniverseView {
  nodes: UniverseNode[];
  edges: UniverseEdge[];
  /** Server-suggested camera focus after a reorganisation (search / more-like-this). */
  focus?: { x: number; y: number; zoom?: number } | null;
  /** Opaque token describing the current organising force, echoed back for paging. */
  context: string;
}

export type ModerationState =
  | 'processing'
  | 'approved'
  | 'needs_review'
  | 'rejected'
  | 'cancelled';

export type PublicRejectionReason =
  | 'unsafe_content'
  | 'personal_information'
  | 'unsupported_image'
  | 'could_not_verify';

export interface UploadSessionPublic {
  sessionId: string;
  state: ModerationState;
  /** Only present on rejection. One broad reason, never a legalistic wall of text. */
  reason?: PublicRejectionReason;
  /** Present once approved & published. */
  artwork?: UniverseNode;
  /** Present exactly once, on a creator's first successful publish. */
  artKey?: string;
  suggestedTitle?: string | null;
  heartbeatIntervalMs: number;
}

export type ReactionKind = 'appreciate' | 'inspired';

export interface ArtworkDetail extends UniverseNode {
  /** Qualitative, private, owner-only signals. Never counts. */
  signals?: QualitativeSignal[];
  owned: boolean;
  /** Whether the viewer has already reacted, so the control can reflect state. */
  reacted: ReactionKind[];
}

export type QualitativeSignal =
  | 'being_discovered'
  | 'traveling'
  | 'lighting_up'
  | 'inspiring_others'
  | 'resting';

export interface MyUniverse {
  nodes: UniverseNode[];
  edges: UniverseEdge[];
  signals: Record<string, QualitativeSignal[]>;
}

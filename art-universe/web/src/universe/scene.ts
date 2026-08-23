import type { UniverseEdge, UniverseNode, UniverseView } from '../../../shared/types.js';

export interface SceneNode extends UniverseNode {
  /** Where the artwork lives in the universe. */
  homeX: number;
  homeY: number;
  /** Where it is being drawn right now, and where it is heading. */
  x: number;
  y: number;
  tx: number;
  ty: number;
  alpha: number;
  targetAlpha: number;
  scale: number;
  targetScale: number;
  seed: number;
  bornAt: number;
}

const hashUnit = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
};

/**
 * The resident set of artworks and where each one is going.
 *
 * The scene never holds the whole universe: it holds what is near, what the
 * current organising force pulled in, and it lets the rest go.
 */
export class Scene {
  nodes = new Map<string, SceneNode>();
  edges: UniverseEdge[] = [];
  focusRef: string | null = null;
  /** 'universe' | 'search' | 'focus' | 'mine' — what is currently arranging space. */
  mode: 'universe' | 'search' | 'focus' | 'mine' = 'universe';
  budget = 320;
  private reducedMotion = false;

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
  }

  /** Merge a server view in. Existing artworks keep their identity and move. */
  apply(view: UniverseView, opts: { mode?: Scene['mode']; retarget?: boolean } = {}) {
    const now = performance.now();
    const incoming = new Set<string>();
    for (const node of view.nodes) {
      incoming.add(node.ref);
      const existing = this.nodes.get(node.ref);
      if (existing) {
        Object.assign(existing, node, {
          homeX: node.x,
          homeY: node.y,
          tx: opts.retarget === false ? existing.tx : node.x,
          ty: opts.retarget === false ? existing.ty : node.y,
          targetAlpha: 1
        });
      } else {
        this.nodes.set(node.ref, {
          ...node,
          homeX: node.x,
          homeY: node.y,
          // New work fades in where it belongs rather than flying in from
          // nowhere: arrival should feel like noticing, not like a transition.
          x: node.x,
          y: node.y,
          tx: node.x,
          ty: node.y,
          alpha: 0,
          targetAlpha: 1,
          scale: 0.86,
          targetScale: 1,
          seed: hashUnit(node.ref),
          bornAt: now
        });
      }
    }
    this.edges = view.edges;
    if (opts.mode) this.mode = opts.mode;
    this.prune(incoming);
  }

  /** Add a single artwork (a freshly published piece travelling into place). */
  add(node: UniverseNode) {
    if (this.nodes.has(node.ref)) return this.nodes.get(node.ref)!;
    const scene: SceneNode = {
      ...node,
      homeX: node.x,
      homeY: node.y,
      x: node.x,
      y: node.y,
      tx: node.x,
      ty: node.y,
      alpha: 0,
      targetAlpha: 1,
      scale: 2.4,
      targetScale: 1,
      seed: hashUnit(node.ref),
      bornAt: performance.now()
    };
    this.nodes.set(node.ref, scene);
    return scene;
  }

  /**
   * Reorganise around a search: the most relevant work travels toward the
   * centre in rings, the rest drifts outward and dims. Searching changes the
   * gravity of the universe rather than producing a list.
   */
  arrangeAroundPoint(refsInOrder: string[], centre: { x: number; y: number }, spread = 1) {
    const ranked = new Set(refsInOrder);
    refsInOrder.forEach((ref, index) => {
      const node = this.nodes.get(ref);
      if (!node) return;
      // Phyllotaxis: even coverage, no visible rows, no grid.
      const angle = index * 2.399963;
      const radius = (150 + Math.sqrt(index) * 210) * spread;
      node.tx = centre.x + Math.cos(angle) * radius;
      node.ty = centre.y + Math.sin(angle) * radius;
      node.targetAlpha = 1;
      node.targetScale = index < 6 ? 1.12 : 1;
    });
    for (const node of this.nodes.values()) {
      if (ranked.has(node.ref)) continue;
      // Less relevant work drifts away rather than disappearing.
      const dx = node.homeX - centre.x;
      const dy = node.homeY - centre.y;
      const d = Math.hypot(dx, dy) || 1;
      node.tx = centre.x + (dx / d) * (d * 1.5 + 900);
      node.ty = centre.y + (dy / d) * (d * 1.5 + 900);
      node.targetAlpha = 0.12;
      node.targetScale = 0.8;
    }
    this.mode = 'search';
  }

  /**
   * Selection: the artwork becomes the centre, related work gently reorganises
   * around it, unrelated work recedes.
   */
  focusOn(ref: string) {
    const focus = this.nodes.get(ref);
    if (!focus) return;
    this.focusRef = ref;
    this.mode = 'focus';

    const related = new Map<string, number>();
    for (const edge of this.edges) {
      if (edge.a === ref) related.set(edge.b, edge.strength + (edge.kind === 'response' ? 1 : 0));
      else if (edge.b === ref) related.set(edge.a, edge.strength + (edge.kind === 'response' ? 1 : 0));
    }
    const ordered = [...related].sort((a, b) => b[1] - a[1]).map(([r]) => r);

    focus.tx = focus.homeX;
    focus.ty = focus.homeY;
    focus.targetAlpha = 1;
    focus.targetScale = 1.5;

    ordered.forEach((r, i) => {
      const node = this.nodes.get(r);
      if (!node) return;
      const angle = (i / Math.max(ordered.length, 1)) * Math.PI * 2 + focus.seed * 6.28;
      const radius = 340 + (i % 3) * 120;
      node.tx = focus.homeX + Math.cos(angle) * radius;
      node.ty = focus.homeY + Math.sin(angle) * radius;
      node.targetAlpha = 1;
      node.targetScale = 1.05;
    });

    const near = new Set([ref, ...ordered]);
    for (const node of this.nodes.values()) {
      if (near.has(node.ref)) continue;
      node.tx = node.homeX;
      node.ty = node.homeY;
      // Receding, not vanishing: the rest of the universe is still there.
      node.targetAlpha = 0.45;
      node.targetScale = 0.94;
    }
  }

  /** Let everything settle back into the universe's own arrangement. */
  release() {
    this.focusRef = null;
    this.mode = 'universe';
    for (const node of this.nodes.values()) {
      node.tx = node.homeX;
      node.ty = node.homeY;
      node.targetAlpha = 1;
      node.targetScale = 1;
    }
  }

  step(dt: number, timeSeconds: number) {
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 2.2);
    const a = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 3);
    for (const node of this.nodes.values()) {
      node.x += (node.tx - node.x) * k;
      node.y += (node.ty - node.y) * k;
      node.alpha += (node.targetAlpha - node.alpha) * a;
      node.scale += (node.targetScale - node.scale) * a;
      if (!this.reducedMotion) {
        // Extremely subtle drift: the universe breathes, it does not float away.
        const t = timeSeconds * 0.12 + node.seed * 60;
        node.x += Math.sin(t) * 0.06;
        node.y += Math.cos(t * 0.87) * 0.06;
      }
    }
  }

  /** Keep the resident set bounded: virtualisation, not a growing pile. */
  private prune(keep: Set<string>) {
    if (this.nodes.size <= this.budget) return;
    const removable = [...this.nodes.values()]
      .filter((n) => !keep.has(n.ref) && n.ref !== this.focusRef)
      .sort((a, b) => a.bornAt - b.bornAt);
    let excess = this.nodes.size - this.budget;
    for (const node of removable) {
      if (excess-- <= 0) break;
      this.nodes.delete(node.ref);
    }
  }

  visible(viewport: { minX: number; minY: number; maxX: number; maxY: number }): SceneNode[] {
    const out: SceneNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.alpha < 0.02) continue;
      if (node.x < viewport.minX || node.x > viewport.maxX) continue;
      if (node.y < viewport.minY || node.y > viewport.maxY) continue;
      out.push(node);
    }
    return out;
  }
}

import type { Camera } from './camera.js';
import type { Scene, SceneNode } from './scene.js';
import { ImageCache } from './images.js';

/** World-space width of an artwork at scale 1. */
const BASE_SIZE = 250;

export interface RenderSettings {
  nodeBudget: number;
  relationshipVisibility: number;
  gravityPresentation: number;
  reducedMotion: boolean;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const v = hex.replace('#', '');
  return [
    parseInt(v.slice(0, 2), 16) || 0,
    parseInt(v.slice(2, 4), 16) || 0,
    parseInt(v.slice(4, 6), 16) || 0
  ];
};

/**
 * Canvas renderer for the universe.
 *
 * Level of detail is the whole design: far artworks are drawn from their
 * palette as small coloured worlds, nearer ones get a thumbnail, and only the
 * pieces you are actually looking at load a large derivative. Nothing outside
 * the padded viewport is drawn at all.
 */
export class UniverseRenderer {
  private ctx: CanvasRenderingContext2D;
  private images = new ImageCache();
  private dpr = 1;
  private backdrop: HTMLCanvasElement | null = null;
  hoverRef: string | null = null;
  keyboardRef: string | null = null;
  /** Rolling frame cost, used to report render pressure and shed load. */
  private frameCost = 16;

  settings: RenderSettings = {
    nodeBudget: 320,
    relationshipVisibility: 1,
    gravityPresentation: 1,
    reducedMotion: false
  };

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number) {
    this.dpr = dpr;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.backdrop = null;
  }

  get lastFrameCost() {
    return this.frameCost;
  }

  /** Which artwork is under a screen point — hit testing in screen space. */
  pick(scene: Scene, camera: Camera, sx: number, sy: number): SceneNode | null {
    let best: SceneNode | null = null;
    let bestArea = Infinity;
    for (const node of scene.visible(camera.viewport(1.05))) {
      const size = BASE_SIZE * camera.zoom * node.scale;
      const w = node.aspect >= 1 ? size : size * node.aspect;
      const h = node.aspect >= 1 ? size / node.aspect : size;
      const x = camera.worldToScreenX(node.x);
      const y = camera.worldToScreenY(node.y);
      const pad = Math.max(6, size * 0.06);
      if (
        sx >= x - w / 2 - pad && sx <= x + w / 2 + pad &&
        sy >= y - h / 2 - pad && sy <= y + h / 2 + pad
      ) {
        const area = w * h;
        if (area < bestArea) {
          bestArea = area;
          best = node;
        }
      }
    }
    return best;
  }

  render(scene: Scene, camera: Camera, timeSeconds: number) {
    const started = performance.now();
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackdrop(ctx, w, h, camera);

    const viewport = camera.viewport(1.25);
    let nodes = scene.visible(viewport);

    // Load shedding: when there is more in view than the device can carry,
    // keep the pieces nearest the centre of attention.
    if (nodes.length > this.settings.nodeBudget) {
      nodes = nodes
        .map((n) => ({
          n,
          d: Math.hypot(n.x - camera.x, n.y - camera.y) * (1 - n.gravity * 0.4)
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this.settings.nodeBudget)
        .map((e) => e.n);
    }

    const onScreen = new Set(nodes.map((n) => n.ref));
    this.drawEdges(ctx, scene, camera, onScreen, timeSeconds);

    // Draw quiet work first so discovered work sits in front of it.
    nodes.sort((a, b) => a.gravity * a.alpha - b.gravity * b.alpha);
    for (const node of nodes) this.drawNode(ctx, node, camera, timeSeconds);

    this.drawVignette(ctx, w, h);
    this.frameCost = this.frameCost * 0.9 + (performance.now() - started) * 0.1;
  }

  /** A still, deep ground with a couple of slow nebulae. Drawn once, reused. */
  private drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, camera: Camera) {
    if (!this.backdrop || this.backdrop.width !== Math.floor(w) || this.backdrop.height !== Math.floor(h)) {
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.floor(w));
      off.height = Math.max(1, Math.floor(h));
      const octx = off.getContext('2d')!;
      const base = octx.createLinearGradient(0, 0, 0, h);
      base.addColorStop(0, '#070b18');
      base.addColorStop(0.55, '#05070f');
      base.addColorStop(1, '#03040a');
      octx.fillStyle = base;
      octx.fillRect(0, 0, w, h);
      this.backdrop = off;
    }
    ctx.drawImage(this.backdrop, 0, 0, w, h);

    // Two very slow parallax clouds give depth without ever calling attention.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const clouds: [number, number, string][] = [
      [-1800, -900, 'rgba(74, 46, 138, 0.16)'],
      [1500, 1200, 'rgba(24, 86, 118, 0.14)']
    ];
    for (const [cx, cy, colour] of clouds) {
      const x = camera.worldToScreenX(cx);
      const y = camera.worldToScreenY(cy);
      const r = 900 * Math.max(camera.zoom, 0.22);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, colour);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /**
   * Relationships. Similarity lines are thin and cool; a response — a human
   * answering with art — is warmer, brighter and carries a travelling spark,
   * so the two never read as the same thing.
   */
  private drawEdges(
    ctx: CanvasRenderingContext2D,
    scene: Scene,
    camera: Camera,
    onScreen: Set<string>,
    time: number
  ) {
    if (this.settings.relationshipVisibility <= 0) return;
    ctx.save();
    ctx.lineCap = 'round';
    for (const edge of scene.edges) {
      if (!onScreen.has(edge.a) || !onScreen.has(edge.b)) continue;
      const a = scene.nodes.get(edge.a);
      const b = scene.nodes.get(edge.b);
      if (!a || !b) continue;

      const focus = scene.focusRef;
      const involved = !focus || focus === a.ref || focus === b.ref;
      const alpha = Math.min(a.alpha, b.alpha) * (involved ? 1 : 0.35) * this.settings.relationshipVisibility;
      if (alpha < 0.04) continue;

      const ax = camera.worldToScreenX(a.x);
      const ay = camera.worldToScreenY(a.y);
      const bx = camera.worldToScreenX(b.x);
      const by = camera.worldToScreenY(b.y);

      // Only draw a relationship that is legible as one. A line stretched across
      // the whole viewport reads as a network diagram rather than a constellation.
      const span = Math.hypot(bx - ax, by - ay);
      const limit = Math.hypot(camera.width, camera.height) * (involved ? 0.85 : 0.55);
      if (span > limit) continue;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      // A gentle bow, so lines read as connections in space rather than as the
      // edges of a diagram.
      const nx = -(by - ay);
      const ny = bx - ax;
      const len = Math.hypot(nx, ny) || 1;
      const bow = Math.min(60, len * 0.09);
      const cx = mx + (nx / len) * bow;
      const cy = my + (ny / len) * bow;

      if (edge.kind === 'response') {
        ctx.strokeStyle = `rgba(206, 168, 255, ${(0.34 * alpha).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, 2.1 * Math.min(camera.zoom * 2.2, 1.7));
      } else {
        ctx.strokeStyle = `rgba(139, 190, 255, ${(0.14 * alpha * edge.strength).toFixed(3)})`;
        ctx.lineWidth = Math.max(0.6, 1.15 * Math.min(camera.zoom * 2, 1.3));
      }
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.stroke();

      if (edge.kind === 'response' && !this.settings.reducedMotion) {
        const t = (time * 0.16 + a.seed) % 1;
        const px = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx;
        const py = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by;
        ctx.fillStyle = `rgba(232, 214, 255, ${(0.5 * alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawNode(
    ctx: CanvasRenderingContext2D,
    node: SceneNode,
    camera: Camera,
    time: number
  ) {
    const size = BASE_SIZE * camera.zoom * node.scale;
    if (size < 2) return;
    const w = node.aspect >= 1 ? size : size * node.aspect;
    const h = node.aspect >= 1 ? size / node.aspect : size;
    const x = camera.worldToScreenX(node.x);
    const y = camera.worldToScreenY(node.y);
    const alpha = node.alpha;
    const gravity = node.gravity * this.settings.gravityPresentation;
    const focused = node.ref === this.hoverRef || node.ref === this.keyboardRef;

    // Visual Gravity: a little more presence, never a bigger badge.
    if (gravity > 0.08) {
      const [r, g, b] = hexToRgb(node.palette[3] ?? node.palette[0] ?? '#8fb4ff');
      const pulse = this.settings.reducedMotion ? 1 : 1 + Math.sin(time * 0.7 + node.seed * 9) * 0.06;
      const radius = Math.max(w, h) * (0.62 + gravity * 0.4) * pulse;
      const glow = ctx.createRadialGradient(x, y, Math.max(w, h) * 0.22, x, y, radius);
      glow.addColorStop(0, `rgba(${r},${g},${b},${(0.3 * gravity * alpha).toFixed(3)})`);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      ctx.restore();
    }

    const priority = Math.hypot(x - camera.width / 2, y - camera.height / 2) / (1 + gravity * 2);

    if (size < 34) {
      // Far: a small coloured world. Distance softens everything.
      this.drawOrb(ctx, node, x, y, Math.max(w, h) * 0.5, alpha * 0.9);
      if (size > 22) this.images.request(node.media.thumb, priority + 4000);
      return;
    }

    const url =
      size > 460 ? node.media.large : size > 150 ? node.media.small : node.media.thumb;
    this.images.request(url, priority);
    // Always keep the cheapest derivative available as an immediate stand-in.
    if (url !== node.media.thumb) this.images.request(node.media.thumb, priority + 1000);

    const image = this.images.get(url) ?? this.images.get(node.media.small) ?? this.images.get(node.media.thumb);

    ctx.save();
    ctx.globalAlpha = alpha;
    if (image) {
      // A thumbnail stretched to a large frame is its own soft-focus: nearer
      // work sharpens as its real derivative arrives.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = Math.min(46, size * 0.16);
      ctx.shadowOffsetY = Math.min(18, size * 0.05);
      ctx.drawImage(image, x - w / 2, y - h / 2, w, h);
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = `rgba(255,255,255,${focused ? 0.4 : 0.09})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    } else {
      this.drawOrb(ctx, node, x, y, Math.max(w, h) * 0.5, alpha);
    }
    ctx.restore();

    if (gravity > 0.42 && !this.settings.reducedMotion) {
      this.drawParticles(ctx, node, x, y, Math.max(w, h), gravity, time, alpha);
    }

    if (focused) {
      ctx.save();
      ctx.strokeStyle = 'rgba(159, 232, 239, 0.85)';
      ctx.lineWidth = 2;
      const pad = Math.max(8, size * 0.05);
      ctx.strokeRect(x - w / 2 - pad, y - h / 2 - pad, w + pad * 2, h + pad * 2);
      ctx.restore();
    }
  }

  /** The far-zoom representation: colour, softness, no detail. */
  private drawOrb(
    ctx: CanvasRenderingContext2D,
    node: SceneNode,
    x: number,
    y: number,
    radius: number,
    alpha: number
  ) {
    const inner = node.palette[3] ?? node.palette[2] ?? '#6fa8dc';
    const outer = node.palette[0] ?? '#0a1020';
    const [ir, ig, ib] = hexToRgb(inner);
    const [or_, og, ob] = hexToRgb(outer);
    const grad = ctx.createRadialGradient(x - radius * 0.2, y - radius * 0.25, radius * 0.1, x, y, radius);
    grad.addColorStop(0, `rgba(${ir},${ig},${ib},${(0.95 * alpha).toFixed(3)})`);
    grad.addColorStop(0.62, `rgba(${ir},${ig},${ib},${(0.5 * alpha).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${or_},${og},${ob},0)`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Delicate particles around work that is being discovered. */
  private drawParticles(
    ctx: CanvasRenderingContext2D,
    node: SceneNode,
    x: number,
    y: number,
    size: number,
    gravity: number,
    time: number,
    alpha: number
  ) {
    const count = Math.min(9, Math.round(2 + gravity * 7));
    const [r, g, b] = hexToRgb(node.palette[4] ?? node.palette[3] ?? '#cfe6ff');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const phase = time * 0.24 + node.seed * 12 + (i / count) * Math.PI * 2;
      const radius = size * (0.62 + 0.16 * Math.sin(phase * 1.7 + i));
      const px = x + Math.cos(phase) * radius;
      const py = y + Math.sin(phase * 0.92) * radius * 0.78;
      const a = (0.16 + 0.2 * Math.sin(phase * 2.2)) * gravity * alpha;
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.78);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}

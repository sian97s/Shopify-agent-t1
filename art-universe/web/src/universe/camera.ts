export interface Viewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The camera. Position is in universe coordinates, zoom is pixels per unit.
 *
 * Movement is always eased toward a target rather than set directly, so every
 * navigation — a drag, a search, a selection — arrives rather than snaps.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 0.42;

  targetX = 0;
  targetY = 0;
  targetZoom = 0.42;

  readonly minZoom = 0.05;
  readonly maxZoom = 3.4;

  constructor(public width = 1, public height = 1, private reducedMotion = false) {}

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
  }

  worldToScreenX(x: number) {
    return (x - this.x) * this.zoom + this.width / 2;
  }
  worldToScreenY(y: number) {
    return (y - this.y) * this.zoom + this.height / 2;
  }
  screenToWorldX(sx: number) {
    return (sx - this.width / 2) / this.zoom + this.x;
  }
  screenToWorldY(sy: number) {
    return (sy - this.height / 2) / this.zoom + this.y;
  }

  /** Padded so work just off-screen is already resident when it arrives. */
  viewport(padding = 1.5): Viewport {
    const halfW = (this.width / 2 / this.zoom) * padding;
    const halfH = (this.height / 2 / this.zoom) * padding;
    return {
      minX: this.x - halfW,
      maxX: this.x + halfW,
      minY: this.y - halfH,
      maxY: this.y + halfH
    };
  }

  panBy(dxScreen: number, dyScreen: number) {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.targetX = this.x;
    this.targetY = this.y;
  }

  /** Zoom about a screen point, so pinch and wheel feel anchored. */
  zoomAt(sx: number, sy: number, factor: number) {
    const worldX = this.screenToWorldX(sx);
    const worldY = this.screenToWorldY(sy);
    const next = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    const applied = next / this.zoom;
    this.x = worldX - (worldX - this.x) / applied;
    this.y = worldY - (worldY - this.y) / applied;
    this.zoom = next;
    this.targetX = this.x;
    this.targetY = this.y;
    this.targetZoom = this.zoom;
  }

  travelTo(x: number, y: number, zoom?: number) {
    this.targetX = x;
    this.targetY = y;
    if (zoom !== undefined) this.targetZoom = clamp(zoom, this.minZoom, this.maxZoom);
    if (this.reducedMotion) this.arrive();
  }

  arrive() {
    this.x = this.targetX;
    this.y = this.targetY;
    this.zoom = this.targetZoom;
  }

  step(dt: number) {
    if (this.reducedMotion) return this.arrive();
    // Exponential approach: frame-rate independent, and it decelerates the way
    // something heavy moving through space would.
    const k = 1 - Math.exp(-dt * 3.1);
    this.x += (this.targetX - this.x) * k;
    this.y += (this.targetY - this.y) * k;
    this.zoom += (this.targetZoom - this.zoom) * (1 - Math.exp(-dt * 2.6));
  }

  get moving() {
    return (
      Math.abs(this.targetX - this.x) > 0.6 ||
      Math.abs(this.targetY - this.y) > 0.6 ||
      Math.abs(this.targetZoom - this.zoom) > 0.0008
    );
  }
}

import type { Camera } from './camera.js';

export interface InputHandlers {
  onTap(sx: number, sy: number): void;
  onHover(sx: number, sy: number): void;
  onMove(): void;
  onGestureFailed(): void;
}

interface Pointer {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startTime: number;
  moved: boolean;
}

/**
 * Pan, zoom and selection for both hands and pointers.
 *
 * Mobile is not a shrunken desktop: one finger pans, two fingers pinch and pan
 * together, and a tap selects. On desktop the same surface takes drag-pan,
 * wheel zoom and trackpad gestures.
 */
export class UniverseInput {
  private pointers = new Map<number, Pointer>();
  private pinchDistance = 0;
  private velocityX = 0;
  private velocityY = 0;
  private lastMoveAt = 0;
  private tuning = { zoomDamping: 1, inertia: 1 };

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private handlers: InputHandlers,
    private reducedMotion = false
  ) {
    canvas.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', this.onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('pointerleave', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  tune(patch: Partial<{ zoomDamping: number; inertia: number }>) {
    Object.assign(this.tuning, patch);
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
  }

  private onPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add('dragging');
    this.pointers.set(event.pointerId, {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startTime: performance.now(),
      moved: false
    });
    this.velocityX = 0;
    this.velocityY = 0;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) {
      if (event.pointerType === 'mouse') this.handlers.onHover(event.clientX, event.clientY);
      return;
    }
    event.preventDefault();
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 7) {
      pointer.moved = true;
    }

    if (this.pointers.size === 1) {
      this.camera.panBy(dx, dy);
      const now = performance.now();
      const dt = Math.max(1, now - this.lastMoveAt);
      this.velocityX = dx / dt;
      this.velocityY = dy / dt;
      this.lastMoveAt = now;
      this.handlers.onMove();
      return;
    }

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (this.pinchDistance > 0 && distance > 0) {
        const raw = distance / this.pinchDistance;
        const factor = 1 + (raw - 1) * this.tuning.zoomDamping;
        this.camera.zoomAt(midX, midY, factor);
      }
      this.pinchDistance = distance;
      // Two-finger drag pans as well, so the hand never has to choose.
      this.camera.panBy(dx / 2, dy / 2);
      this.handlers.onMove();
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    const pointer = this.pointers.get(event.pointerId);
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    if (this.pointers.size === 0) this.canvas.classList.remove('dragging');
    if (!pointer) return;

    const heldFor = performance.now() - pointer.startTime;
    if (!pointer.moved && heldFor < 700) {
      this.handlers.onTap(pointer.x, pointer.y);
      return;
    }
    if (pointer.moved && !this.reducedMotion) this.applyInertia();
    // A long press that never became a drag or a tap is a gesture that did not
    // land — worth knowing about, anonymously.
    if (!pointer.moved && heldFor >= 700) this.handlers.onGestureFailed();
  };

  private onPointerCancel = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    this.canvas.classList.remove('dragging');
    this.handlers.onGestureFailed();
  };

  private applyInertia() {
    const speed = Math.hypot(this.velocityX, this.velocityY);
    if (speed < 0.12) return;
    const glide = 190 * this.tuning.inertia;
    this.camera.travelTo(
      this.camera.x - (this.velocityX * glide) / this.camera.zoom,
      this.camera.y - (this.velocityY * glide) / this.camera.zoom
    );
    this.handlers.onMove();
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const intensity = event.deltaMode === 1 ? 18 : 1;
    const delta = event.deltaY * intensity;
    const factor = Math.exp(-delta * 0.0016 * this.tuning.zoomDamping);
    this.camera.zoomAt(event.clientX, event.clientY, factor);
    this.handlers.onMove();
  };

  private onDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    this.camera.zoomAt(event.clientX, event.clientY, 1.9);
    this.handlers.onMove();
  };
}

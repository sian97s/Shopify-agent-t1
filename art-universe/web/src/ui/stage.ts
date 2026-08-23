import { clear, trapFocus } from './dom.js';

/**
 * The one full-surface layer. Upload, the Art Key and My Universe all render
 * here, one at a time, over a universe that stays visible behind them.
 */
export class Stage {
  private root: HTMLElement;
  private release: (() => void) | null = null;
  private onClose: (() => void) | null = null;
  private dismissable = true;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.addEventListener('click', (event) => {
      if (event.target === this.root && this.dismissable) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen && this.dismissable) this.close();
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open(
    content: HTMLElement,
    opts: { dismissable?: boolean; onClose?: () => void; translucent?: boolean } = {}
  ) {
    this.dismissable = opts.dismissable ?? true;
    this.onClose = opts.onClose ?? null;
    clear(this.root);
    this.root.append(content);
    this.root.hidden = false;
    // While the universe is forming behind a sheet, let it show through.
    this.root.style.background = opts.translucent
      ? 'radial-gradient(120% 90% at 50% 40%, rgba(6,9,20,0.42), rgba(3,4,10,0.72))'
      : '';
    this.release?.();
    this.release = trapFocus(content);
  }

  /** Swap the contents without losing the layer or the focus trap. */
  replace(content: HTMLElement) {
    clear(this.root);
    this.root.append(content);
    this.release?.();
    this.release = trapFocus(content);
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    clear(this.root);
    this.release?.();
    this.release = null;
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }
}

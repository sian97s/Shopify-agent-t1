import { api } from './net/api.js';

/**
 * Anonymous aggregate analytics, batched and fire-and-forget.
 *
 * Only event names from a fixed list are accepted by the server, and only
 * numbers, booleans and short enum-like strings survive as properties. There is
 * nothing here that identifies anyone.
 */
class Analytics {
  private queue: { name: string; props?: Record<string, unknown> }[] = [];
  private timer: number | null = null;

  track(name: string, props: Record<string, unknown> = {}) {
    this.queue.push({ name, props });
    if (this.queue.length >= 20) this.flush();
    else if (this.timer === null) {
      this.timer = window.setTimeout(() => this.flush(), 6000);
    }
  }

  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 40);
    void api.events(batch);
  }
}

export const analytics = new Analytics();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') analytics.flush();
});

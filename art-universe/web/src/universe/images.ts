/**
 * Progressive image loading.
 *
 * Nothing is fetched until it is worth drawing: far artworks are painted from
 * their palette alone, and only as a piece approaches does its thumbnail, then
 * its larger derivative, get requested. Requests are prioritised by how close
 * the artwork is to the centre of attention.
 */
export class ImageCache {
  private images = new Map<string, HTMLImageElement>();
  private failed = new Set<string>();
  private inFlight = new Map<string, HTMLImageElement>();
  private queue: { url: string; priority: number }[] = [];
  private used = new Map<string, number>();

  constructor(private maxConcurrent = 6, private capacity = 400) {}

  get(url: string): HTMLImageElement | null {
    const img = this.images.get(url);
    if (img) this.used.set(url, performance.now());
    return img ?? null;
  }

  /** Ask for an image. Lower priority number = wanted sooner. */
  request(url: string, priority = 1) {
    if (this.images.has(url) || this.inFlight.has(url) || this.failed.has(url)) return;
    const queued = this.queue.find((q) => q.url === url);
    if (queued) {
      queued.priority = Math.min(queued.priority, priority);
      return;
    }
    this.queue.push({ url, priority });
    this.pump();
  }

  private pump() {
    while (this.inFlight.size < this.maxConcurrent && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const next = this.queue.shift()!;
      const img = new Image();
      img.decoding = 'async';
      img.loading = 'eager';
      this.inFlight.set(next.url, img);
      img.onload = () => {
        this.inFlight.delete(next.url);
        this.images.set(next.url, img);
        this.used.set(next.url, performance.now());
        this.evict();
        this.pump();
      };
      img.onerror = () => {
        this.inFlight.delete(next.url);
        this.failed.add(next.url);
        this.pump();
      };
      img.src = next.url;
    }
  }

  private evict() {
    if (this.images.size <= this.capacity) return;
    const oldest = [...this.used].sort((a, b) => a[1] - b[1]).slice(0, this.images.size - this.capacity);
    for (const [url] of oldest) {
      this.images.delete(url);
      this.used.delete(url);
    }
  }

  get pending() {
    return this.queue.length + this.inFlight.size;
  }
}

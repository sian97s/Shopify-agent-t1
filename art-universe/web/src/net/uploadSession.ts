import type { ModerationState, UploadSessionPublic } from '../../../shared/types.js';
import { api } from './api.js';

export interface LiveSessionEvents {
  onStage?(stage: string): void;
  onState?(state: ModerationState): void;
  onLost?(): void;
}

/**
 * Keeps an upload session alive for as long as the creator is actually here.
 *
 * A websocket carries the heartbeat, with an HTTP heartbeat as a fallback. If
 * the tab is backgrounded — which phones do constantly — the heartbeat slows
 * but does not stop, and the server's grace window covers the gap. Only really
 * leaving cancels the submission.
 */
export class LiveUploadSession {
  private socket: WebSocket | null = null;
  private timer: number | null = null;
  private closed = false;
  private reconnectDelay = 800;

  constructor(
    public readonly id: string,
    public readonly token: string,
    private intervalMs: number,
    private events: LiveSessionEvents = {}
  ) {
    this.connect();
    this.timer = window.setInterval(() => this.beat(), Math.max(2000, intervalMs));
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private connect() {
    if (this.closed) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      this.socket = new WebSocket(`${protocol}://${location.host}/ws/upload`);
    } catch {
      return; // HTTP heartbeat still keeps the session alive.
    }
    this.socket.addEventListener('open', () => {
      this.reconnectDelay = 800;
      this.socket?.send(JSON.stringify({ type: 'attach', sessionId: this.id }));
    });
    this.socket.addEventListener('message', (event) => {
      let msg: { type?: string; stage?: string; payload?: UploadSessionPublic; state?: ModerationState };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === 'stage' && msg.stage) this.events.onStage?.(msg.stage);
      if (msg.type === 'state' && msg.payload?.state) this.events.onState?.(msg.payload.state);
      if (msg.type === 'alive' && msg.state) this.events.onState?.(msg.state);
    });
    this.socket.addEventListener('close', () => {
      if (this.closed) return;
      // Reconnect rather than give up: a dropped socket is not abandonment.
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.8, 8000);
      window.setTimeout(() => this.connect(), this.reconnectDelay);
    });
  }

  private beat() {
    if (this.closed) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'heartbeat', sessionId: this.id }));
      return;
    }
    void api
      .heartbeat(this.id, this.token)
      .then((s) => this.events.onState?.(s.state))
      .catch(() => this.events.onLost?.());
  }

  private onVisibility = () => {
    // Coming back from the app switcher: prove we are still here immediately.
    if (document.visibilityState === 'visible') this.beat();
  };

  private onPageHide = () => {
    // Leaving the page cancels the submission. Nothing appears afterwards.
    if (!this.closed) void api.cancelUpload(this.id, this.token);
  };

  /** Stop keeping the session alive. `cancel` also tells the server to drop it. */
  close(cancel = false) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.socket?.close();
    if (cancel) void api.cancelUpload(this.id, this.token);
  }
}

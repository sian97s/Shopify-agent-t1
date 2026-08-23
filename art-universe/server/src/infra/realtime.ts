import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

type Handler = (msg: Record<string, unknown>, socket: SessionSocket) => void;

export interface SessionSocket {
  send(msg: Record<string, unknown>): void;
  close(): void;
  sessionId: string | null;
}

/**
 * The live channel that keeps an upload session alive. This is the only
 * realtime surface in the product: no chat, no presence, no notifications.
 */
export class RealtimeHub {
  private wss: WebSocketServer;
  private bySession = new Map<string, Set<WebSocket>>();
  private onMessage: Handler = () => {};
  private onClose: (sessionId: string, remaining: number) => void = () => {};
  private onOpenSession: (sessionId: string) => void = () => {};

  constructor(server: Server, path = '/ws/upload') {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on('connection', (ws) => {
      const wrapper: SessionSocket = {
        sessionId: null,
        send: (m) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
        },
        close: () => ws.close()
      };
      ws.on('message', (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'attach' && typeof msg.sessionId === 'string') {
          wrapper.sessionId = msg.sessionId;
          let set = this.bySession.get(msg.sessionId);
          if (!set) this.bySession.set(msg.sessionId, (set = new Set()));
          set.add(ws);
          this.onOpenSession(msg.sessionId);
        }
        this.onMessage(msg, wrapper);
      });
      ws.on('close', () => {
        const id = wrapper.sessionId;
        if (!id) return;
        const set = this.bySession.get(id);
        set?.delete(ws);
        const remaining = set?.size ?? 0;
        if (remaining === 0) this.bySession.delete(id);
        this.onClose(id, remaining);
      });
    });
  }

  handle(fn: Handler) {
    this.onMessage = fn;
  }
  onSessionAttached(fn: (sessionId: string) => void) {
    this.onOpenSession = fn;
  }
  onSessionDisconnected(fn: (sessionId: string, remaining: number) => void) {
    this.onClose = fn;
  }

  connections(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  broadcast(sessionId: string, msg: Record<string, unknown>) {
    for (const ws of this.bySession.get(sessionId) ?? []) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    }
  }

  close() {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}

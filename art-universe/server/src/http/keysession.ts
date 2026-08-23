import crypto from 'node:crypto';

/**
 * A returning creator gets a short-lived bearer token derived from their Art
 * Key id. It is stateless (HMAC, no server record), it expires, and the Art Key
 * itself never travels again after the first exchange.
 */
export class KeySessionTokens {
  constructor(private secret: Buffer, private ttlMs = 12 * 3600_000) {}

  issue(artKeyId: string, now = Date.now()): string {
    const expires = now + this.ttlMs;
    const payload = `${artKeyId}.${expires}`;
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${Buffer.from(payload).toString('base64url')}.${sig}`;
  }

  verify(token: string | undefined, now = Date.now()): string | null {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    let payload: string;
    try {
      payload = Buffer.from(body, 'base64url').toString();
    } catch {
      return null;
    }
    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const [artKeyId, expiresRaw] = payload.split('.');
    if (!artKeyId || Number(expiresRaw) < now) return null;
    return artKeyId;
  }
}

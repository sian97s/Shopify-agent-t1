import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import 'dotenv/config';

const int = (v: string | undefined, fallback: number) => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  port: int(process.env.PORT, 8788),
  dataDir,
  dbFile: path.join(dataDir, 'universe.db'),
  mediaDir: path.join(dataDir, 'media'),
  tmpDir: path.join(dataDir, 'tmp'),

  /** How long an upload session may live in total. */
  uploadSessionTtlMs: int(process.env.UPLOAD_SESSION_TTL_MS, 10 * 60_000),
  /**
   * Mobile grace window: how long we tolerate a missing heartbeat before the
   * session is considered abandoned. Phones suspend tabs; a short background
   * trip must not cancel an upload (§8 "Mobile grace").
   */
  uploadSessionGraceMs: int(process.env.UPLOAD_SESSION_GRACE_MS, 90_000),
  heartbeatIntervalMs: int(process.env.HEARTBEAT_INTERVAL_MS, 5_000),
  sessionReaperIntervalMs: int(process.env.SESSION_REAPER_INTERVAL_MS, 5_000),

  maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 20 * 1024 * 1024),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
  anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5',

  adminToken: process.env.ADMIN_TOKEN?.trim() || crypto.randomBytes(24).toString('base64url'),

  /** Half-life of visual gravity, in ms. Recent attention must outweigh lifetime totals (§13). */
  gravityHalfLifeMs: int(process.env.GRAVITY_HALF_LIFE_MS, 7 * 24 * 3600_000)
};

fs.mkdirSync(config.mediaDir, { recursive: true });
fs.mkdirSync(config.tmpDir, { recursive: true });

export type Config = typeof config;

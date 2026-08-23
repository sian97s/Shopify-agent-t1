import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA } from './schema.js';

export type Db = Database.Database;

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** sqlite-vec takes raw little-endian float32 buffers. */
export const toVectorBlob = (v: Float32Array | number[]): Buffer =>
  Buffer.from((v instanceof Float32Array ? v : Float32Array.from(v)).buffer);

/**
 * Vectors are L2-normalised before storage, so squared euclidean distance is a
 * monotone function of cosine similarity: cos = 1 - d^2 / 2.
 */
export const distanceToCosine = (distance: number): number => 1 - (distance * distance) / 2;

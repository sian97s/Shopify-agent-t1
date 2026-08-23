import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Object storage boundary. The local driver below is the default so the app
 * runs with no external services; an S3/R2 driver only has to implement this
 * interface (see README "Substitutions").
 */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(prefix: string): Promise<void>;
  url(key: string): string;
}

export class LocalDiskStorage implements ObjectStorage {
  constructor(private root: string, private publicPath = '/media') {}

  private resolve(key: string) {
    const safe = key.replace(/\.\.+/g, '.').replace(/^\/+/, '');
    return path.join(this.root, safe);
  }

  async put(key: string, body: Buffer) {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }

  async get(key: string) {
    return fs.readFile(this.resolve(key));
  }

  async remove(prefix: string) {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }

  url(key: string) {
    return `${this.publicPath}/${key}`;
  }
}

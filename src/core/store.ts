import { mkdir, readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job } from './types.js';
import { validEvent } from './types.js';
import type { InstanceRecord } from '../instances/registry.js';
export interface Snapshot { version: 1; jobs: Job[]; instances: Array<Omit<InstanceRecord, 'bots'>> }
export class JsonStore {
  private writing: Promise<void> = Promise.resolve();
  private file: string;
  constructor(private dir: string, mode: string) { this.file = join(dir, `${mode}-state.json`); }
  async load(): Promise<Snapshot | undefined> {
    for (const file of [this.file, `${this.file}.bak`]) {
      try {
        if ((await stat(file)).size > 32_000_000) throw new Error('Snapshot too large');
        const value = JSON.parse(await readFile(file, 'utf8')) as Snapshot;
        if (value.version !== 1 || !Array.isArray(value.jobs) || !Array.isArray(value.instances) ||
            !value.jobs.every(j => j && validEvent(j.event) && j.id === j.event.id && ['QUEUED','ASSIGNED','RUNNING','COMPLETED','FAILED','EXPIRED'].includes(j.state) && Number.isSafeInteger(j.attempts) && j.attempts >= 0 && Number.isSafeInteger(j.lease) && j.lease >= 0 && Number.isFinite(j.updatedAt) && Number.isFinite(j.availableAt)) ||
            !value.instances.every(r => r && typeof r.id === 'string' && /^[\w.-]{1,128}$/.test(r.id) && Number.isFinite(r.firstSeen) && Number.isFinite(r.lastSeen))) throw new Error('Invalid snapshot');
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && file.endsWith('.bak')) throw new Error('Cannot restore state; inspect local snapshots');
        if (!file.endsWith('.bak') && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Keep original evidence; recover only from a valid backup.
          try { await stat(`${this.file}.bak`); } catch { throw new Error('State damaged without backup; inspect local snapshot'); }
        }
      }
    }
    return undefined;
  }
  save(snapshot: Snapshot): Promise<void> {
    const body = JSON.stringify(snapshot);
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, body, { encoding: 'utf8', flush: true });
      try { await copyFile(this.file, `${this.file}.bak`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temp, this.file);
    });
    return this.writing;
  }
}

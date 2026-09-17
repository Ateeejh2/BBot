import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogFields { botId?: string; accountLabel?: string; instance?: string; state?: string; jobId?: string; eventId?: string; [key: string]: unknown }
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
export class Logger {
  private bytes = 0;
  private file?: string;
  constructor(private level: LogLevel = 'info', dir?: string, private maxBytes = 5_000_000, private files = 3, private secrets: string[] = []) {
    if (dir) { mkdirSync(dir, { recursive: true }); this.file = join(dir, 'bbot.jsonl'); this.bytes = existsSync(this.file) ? statSync(this.file).size : 0; }
  }
  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (levels[level] < levels[this.level]) return;
    let line = JSON.stringify({ ...fields, timestamp: new Date().toISOString(), level, message,
      botId: fields.botId ?? null, accountLabel: fields.accountLabel ?? null,
      instance: fields.instance ?? null, state: fields.state ?? null,
      eventId: fields.eventId ?? null, jobId: fields.jobId ?? null
    }, (key, value: unknown) => /password|token|secret|username|email|authorization/i.test(key) ? '[REDACTED]' : value);
    for (const secret of this.secrets) if (secret) line = line.split(secret).join('[REDACTED]');
    line += '\n';
    process.stdout.write(line);
    if (this.file) {
      try {
        if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
          rmSync(`${this.file}.${this.files}`, { force: true });
          for (let i = this.files - 1; i >= 1; i--) if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
          if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
          this.bytes = 0;
        }
        appendFileSync(this.file, line); this.bytes += Buffer.byteLength(line);
      } catch { this.file = undefined; process.stderr.write('File logging disabled: local write failed\n'); }
    }
  }
}

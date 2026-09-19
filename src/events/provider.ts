import { validEvent, type GameEvent } from '../core/types.js';
import { abortableDelay, backoff } from '../recovery/backoff.js';
export interface EventProvider { fetchEvents(signal?: AbortSignal): Promise<GameEvent[]> }
export interface EventFeedV1 { version: 1; events: GameEvent[] }

export function parseEventFeedV1(body: unknown): GameEvent[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid event feed');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'events,version' || record.version !== 1 || !Array.isArray(record.events) ||
      record.events.length > 2000 || !record.events.every(validEvent)) throw new Error('Invalid event feed');
  return structuredClone(record.events as GameEvent[]);
}

export class MockEventProvider implements EventProvider {
  constructor(private readonly events: GameEvent[] = [], private readonly now = Date.now) {}
  async fetchEvents(signal?: AbortSignal): Promise<GameEvent[]> {
    signal?.throwIfAborted();
    return structuredClone(this.events.filter(e => e.expiresAt > this.now()));
  }
}
export interface HttpOptions { timeoutMs: number; retries: number; minIntervalMs: number; maxBytes: number; maxRetryMs: number }
export class HttpEventProvider implements EventProvider {
  private nextAllowedAt = 0;
  private pending?: Promise<GameEvent[]>;
  constructor(private url: URL, private parse: (body: unknown) => GameEvent[],
    private options: HttpOptions = { timeoutMs: 10000, retries: 2, minIntervalMs: 10000, maxBytes: 1_000_000, maxRetryMs: 60000 },
    private request: typeof fetch = fetch) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL');
    if (![options.timeoutMs, options.minIntervalMs, options.maxBytes, options.maxRetryMs].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(options.retries) || options.retries < 0 || options.retries > 10) throw new Error('Invalid HTTP options');
  }
  fetchEvents(signal = new AbortController().signal): Promise<GameEvent[]> {
    if (this.pending) return this.pending;
    this.pending = this.fetch(signal).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async fetch(signal: AbortSignal): Promise<GameEvent[]> {
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      await abortableDelay(Math.max(0, this.nextAllowedAt - Date.now()), signal);
      this.nextAllowedAt = Date.now() + this.options.minIntervalMs;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, this.options.timeoutMs);
      let retryable = true;
      try {
        const response = await this.request(this.url, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel();
          retryable = response.status === 429 || response.status >= 500;
          const header = response.headers.get('retry-after');
          const retryAfter = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
          if (Number.isFinite(retryAfter)) this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + Math.max(0, retryAfter));
          throw new Error('HTTP provider request failed');
        }
        const chunks: Uint8Array[] = []; let length = 0;
        const reader = response.body?.getReader();
        if (!reader) { retryable = false; throw new Error('Empty event body'); }
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            length += part.value.byteLength;
            if (length > this.options.maxBytes) { retryable = false; await reader.cancel(); throw new Error('Event body too large'); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        retryable = false;
        const events = this.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        if (!Array.isArray(events) || events.length > 2000 || !events.every(validEvent)) throw new Error('Invalid event payload');
        return events;
      } catch {
        if (signal.aborted) throw new Error('Aborted');
        if (!retryable || attempt === this.options.retries) throw new Error('Event provider failed (transport or payload)');
        this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + backoff(attempt, { baseMs: 1000, maxMs: this.options.maxRetryMs, jitter: 0.5 }));
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    return [];
  }
}

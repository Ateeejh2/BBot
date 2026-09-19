const SOURCE_URL = new URL('https://raw.githubusercontent.com/BrookeAFK/brookeafk-api/main/events.js');
const SOURCE_PAGE = 'https://brookeafk.com/';
const MAX_BODY_BYTES = 2_000_000;
const REFRESH_MS = 60_000;

interface BrookeEvent {
  event: string;
  timestamp: number;
  type: 'major' | 'minor';
}

export interface UpcomingCarePackage {
  timestamp: number;
}

export interface CarePackageScheduleSnapshot {
  source: 'brookeafk.com';
  sourceUrl: string;
  updatedAt?: number;
  status: 'OK' | 'STALE' | 'UNAVAILABLE';
  events: UpcomingCarePackage[];
}

export interface CarePackageSchedule {
  refresh(): Promise<void>;
  snapshot(): CarePackageScheduleSnapshot;
}

function parseBrookeEvents(value: unknown): BrookeEvent[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid Brooke event feed');
  const events: BrookeEvent[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid Brooke event');
    const entry = item as Record<string, unknown>;
    if (typeof entry.event !== 'string' || entry.event.length < 1 || entry.event.length > 80 ||
        !Number.isSafeInteger(entry.timestamp) || (entry.type !== 'major' && entry.type !== 'minor')) {
      throw new Error('Invalid Brooke event');
    }
    events.push({ event: entry.event, timestamp: entry.timestamp as number, type: entry.type });
  }
  return events;
}

export class BrookeCarePackageSchedule implements CarePackageSchedule {
  private timestamps: number[] = [];
  private updatedAt?: number;
  private attemptedAt?: number;
  private pending?: Promise<void>;

  constructor(private request: typeof fetch = fetch, private now = Date.now) {}

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.attemptedAt = this.now();
    this.pending = this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  snapshot(): CarePackageScheduleSnapshot {
    const now = this.now();
    const events = this.timestamps.filter(timestamp => timestamp > now).slice(0, 5).map(timestamp => ({ timestamp }));
    const age = this.updatedAt === undefined ? Infinity : now - this.updatedAt;
    return {
      source: 'brookeafk.com',
      sourceUrl: SOURCE_PAGE,
      updatedAt: this.updatedAt,
      status: this.updatedAt === undefined ? 'UNAVAILABLE' : age > REFRESH_MS * 2 ? 'STALE' : 'OK',
      events
    };
  }

  private async load(): Promise<void> {
    const response = await this.request(SOURCE_URL, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Care Package source request failed'); }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_BODY_BYTES) throw new Error('Care Package source body too large');
    const parsed = parseBrookeEvents(JSON.parse(Buffer.from(body).toString('utf8')) as unknown);
    const now = this.now();
    this.timestamps = parsed
      .filter(event => event.event === 'Care Package' && event.type === 'minor' && event.timestamp > now)
      .map(event => event.timestamp)
      .sort((a, b) => a - b);
    this.updatedAt = now;
  }
}

export const carePackageRefreshMs = REFRESH_MS;

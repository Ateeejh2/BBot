import { isIP } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface NetworkIdentityPoint {
  ip: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  asn?: number;
  organization?: string;
  observedAt: number;
}

export type NetworkIdentityRiskLevel = 'Safe' | 'Caution' | 'Warning' | 'Dangerous' | 'Unknown';

export interface NetworkIdentityChanges {
  ip: boolean;
  asn: boolean;
  country: boolean;
  region: boolean;
  city: boolean;
}

export interface NetworkIdentityRecentChanges {
  windowMs: number;
  since: number;
  ip: number;
  asn: number;
  country: number;
  region: number;
}

export interface NetworkIdentityRisk {
  score?: number;
  level: NetworkIdentityRiskLevel;
  reasons: string[];
}

export interface NetworkIdentitySnapshot {
  status: 'CHECKING' | 'OK' | 'UNAVAILABLE';
  current?: NetworkIdentityPoint;
  previous?: NetworkIdentityPoint;
  changed: boolean;
  ipChanged?: boolean;
  changes?: NetworkIdentityChanges;
  recentChanges?: NetworkIdentityRecentChanges;
  risk: NetworkIdentityRisk;
  checkedAt?: number;
}

type LookupResult = Omit<NetworkIdentityPoint, 'observedAt'>;
export type NetworkIdentityLookup = (signal: AbortSignal) => Promise<LookupResult>;

interface StoredNetworkIdentityState {
  version: 1;
  latest: NetworkIdentityPoint;
  history: NetworkIdentityPoint[];
}

const RECENT_CHANGE_WINDOW_MS = 6 * 60 * 60 * 1000;
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 512;

function pointChanges(previous: NetworkIdentityPoint, current: NetworkIdentityPoint): NetworkIdentityChanges {
  return {
    ip: previous.ip !== current.ip,
    asn: previous.asn !== undefined && current.asn !== undefined && previous.asn !== current.asn,
    country: previous.countryCode !== undefined && current.countryCode !== undefined && previous.countryCode !== current.countryCode,
    region: previous.region !== undefined && current.region !== undefined && previous.region !== current.region,
    city: previous.city !== undefined && current.city !== undefined && previous.city !== current.city
  };
}

export function summarizeRecentNetworkChanges(
  points: NetworkIdentityPoint[],
  now = Date.now(),
  windowMs = RECENT_CHANGE_WINDOW_MS
): NetworkIdentityRecentChanges {
  const since = now - windowMs;
  const ordered = points
    .filter(point => Number.isFinite(point.observedAt) && point.observedAt <= now)
    .slice()
    .sort((a, b) => a.observedAt - b.observedAt);
  let first = ordered.findIndex(point => point.observedAt >= since);
  if (first < 0) first = ordered.length;
  first = Math.max(0, first - 1);
  const recent = ordered.slice(first);
  let ip = 0;
  let asn = 0;
  let country = 0;
  let region = 0;
  for (let index = 1; index < recent.length; index++) {
    const previous = recent[index - 1]!;
    const current = recent[index]!;
    if (current.observedAt < since) continue;
    const changes = pointChanges(previous, current);
    if (changes.ip) ip++;
    if (changes.asn) asn++;
    if (changes.country) country++;
    if (changes.region) region++;
  }
  return { windowMs, since, ip, asn, country, region };
}

export function assessNetworkIdentityRisk(
  previous: NetworkIdentityPoint | undefined,
  current: NetworkIdentityPoint | undefined,
  recentChanges?: NetworkIdentityRecentChanges
): { changes?: NetworkIdentityChanges; risk: NetworkIdentityRisk } {
  if (!previous || !current) {
    return { risk: { level: 'Unknown', reasons: ['No comparable previous network identity'] } };
  }

  const changes = pointChanges(previous, current);
  let score = 0;
  const reasons: string[] = [];

  if (changes.ip) { score += 20; reasons.push('Public IP changed (+20)'); }
  if (changes.asn) { score += 25; reasons.push('ASN changed (+25)'); }
  if (changes.country) { score += 40; reasons.push('Country changed (+40)'); }
  if (changes.region) { score += 15; reasons.push('Region changed (+15)'); }
  if (changes.city) { score += 5; reasons.push('City changed (+5)'); }

  if (recentChanges) {
    if (recentChanges.ip >= 2) {
      const bonus = Math.min(30, (recentChanges.ip - 1) * 10);
      score += bonus;
      reasons.push(String(recentChanges.ip) + ' public IP changes in 6h (+' + bonus + ')');
    }
    if (recentChanges.asn >= 2) {
      const bonus = Math.min(20, (recentChanges.asn - 1) * 10);
      score += bonus;
      reasons.push(String(recentChanges.asn) + ' ASN changes in 6h (+' + bonus + ')');
    }
    if (recentChanges.country >= 2) {
      score += 20;
      reasons.push(String(recentChanges.country) + ' country changes in 6h (+20)');
    }
  }

  score = Math.min(100, score);
  const level: NetworkIdentityRiskLevel =
    score >= 70 ? 'Dangerous' :
    score >= 45 ? 'Warning' :
    score >= 20 ? 'Caution' :
    'Safe';

  if (!reasons.length) reasons.push('No monitored network identity changes');
  return { changes, risk: { score, level, reasons } };
}

const textField = (value: unknown, max = 160): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;

function asnField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return undefined;
  const match = /^(?:AS)?([1-9]\d*)$/i.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function lookupPublicNetworkIdentity(signal: AbortSignal): Promise<LookupResult> {
  const response = await fetch('https://ipwho.is/', {
    signal,
    headers: { accept: 'application/json', 'user-agent': 'BBot/0.1 network-diagnostic' }
  });
  if (!response.ok) throw new Error('NETWORK_IDENTITY_LOOKUP_FAILED');
  const raw = await response.json() as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('NETWORK_IDENTITY_LOOKUP_FAILED');
  const value = raw as Record<string, unknown>;
  if (value.success === false) throw new Error('NETWORK_IDENTITY_LOOKUP_FAILED');
  const ip = textField(value.ip, 64);
  if (!ip || !isIP(ip)) throw new Error('NETWORK_IDENTITY_LOOKUP_FAILED');

  const connection = value.connection && typeof value.connection === 'object' && !Array.isArray(value.connection)
    ? value.connection as Record<string, unknown>
    : undefined;

  return {
    ip,
    country: textField(value.country, 100),
    countryCode: textField(value.country_code, 8),
    region: textField(value.region, 100),
    city: textField(value.city, 100),
    asn: asnField(connection?.asn),
    organization: textField(connection?.org, 160)
  };
}

function validStoredPoint(value: unknown): NetworkIdentityPoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.ip !== 'string' || !isIP(raw.ip) || typeof raw.observedAt !== 'number' || !Number.isFinite(raw.observedAt)) return;
  return {
    ip: raw.ip,
    observedAt: raw.observedAt,
    country: textField(raw.country, 100),
    countryCode: textField(raw.countryCode, 8),
    region: textField(raw.region, 100),
    city: textField(raw.city, 100),
    asn: asnField(raw.asn),
    organization: textField(raw.organization, 160)
  };
}

function validStoredState(value: unknown): { latest?: NetworkIdentityPoint; history: NetworkIdentityPoint[] } {
  const legacy = validStoredPoint(value);
  if (legacy) return { latest: legacy, history: [legacy] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { history: [] };
  const raw = value as Record<string, unknown>;
  const latest = validStoredPoint(raw.latest);
  const history = Array.isArray(raw.history)
    ? raw.history.map(validStoredPoint).filter((point): point is NetworkIdentityPoint => Boolean(point))
    : [];
  if (latest && !history.some(point => point.observedAt === latest.observedAt && point.ip === latest.ip)) history.push(latest);
  history.sort((a, b) => a.observedAt - b.observedAt);
  return { latest, history };
}

export class NetworkIdentityMonitor {
  private value: NetworkIdentitySnapshot = {
    status: 'CHECKING',
    changed: false,
    risk: { level: 'Unknown', reasons: ['Checking network identity'] }
  };
  private baseline?: NetworkIdentityPoint;
  private history: NetworkIdentityPoint[] = [];
  private baselineLoaded = false;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private running = false;
  private closed = false;

  constructor(
    private readonly dataDir: string,
    private readonly onChange: () => void = () => {},
    private readonly intervalMs = 5 * 60 * 1000,
    private readonly lookup: NetworkIdentityLookup = lookupPublicNetworkIdentity
  ) {}

  snapshot(): NetworkIdentitySnapshot {
    return {
      ...this.value,
      current: this.value.current ? { ...this.value.current } : undefined,
      previous: this.value.previous ? { ...this.value.previous } : undefined,
      changes: this.value.changes ? { ...this.value.changes } : undefined,
      recentChanges: this.value.recentChanges ? { ...this.value.recentChanges } : undefined,
      risk: { ...this.value.risk, reasons: [...this.value.risk.reasons] }
    };
  }

  start(): void {
    if (this.closed || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  async refresh(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      if (!this.baselineLoaded) {
        const stored = await this.readPrevious();
        this.baseline = stored.latest;
        this.history = stored.history;
        this.baselineLoaded = true;
      }

      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 4000);
      timeout.unref();
      try {
        const found = await this.lookup(controller.signal);
        if (this.closed || controller.signal.aborted) return;
        const now = Date.now();
        const current: NetworkIdentityPoint = { ...found, observedAt: now };
        const previous = this.baseline;
        const history = this.retainedHistory([...this.history, current], now);
        const recentChanges = summarizeRecentNetworkChanges(history, now);
        const assessed = assessNetworkIdentityRisk(previous, current, recentChanges);
        const changed = Boolean(assessed.changes && Object.values(assessed.changes).some(Boolean));
        this.value = {
          status: 'OK',
          current,
          previous,
          changed,
          ipChanged: assessed.changes?.ip,
          changes: assessed.changes,
          recentChanges,
          risk: assessed.risk,
          checkedAt: now
        };
        this.onChange();
        this.baseline = current;
        this.history = history;
        try { await this.persist(current, history); } catch { /* Display remains valid even if persistence fails. */ }
      } finally {
        clearTimeout(timeout);
        if (this.controller === controller) this.controller = undefined;
      }
    } catch {
      if (!this.closed) {
        this.value = {
          status: 'UNAVAILABLE',
          previous: this.baseline,
          changed: false,
          recentChanges: summarizeRecentNetworkChanges(this.history),
          risk: { level: 'Unknown', reasons: ['Current network identity lookup failed'] },
          checkedAt: Date.now()
        };
        this.onChange();
      }
    } finally {
      this.running = false;
    }
  }

  private retainedHistory(points: NetworkIdentityPoint[], now: number): NetworkIdentityPoint[] {
    const cutoff = now - HISTORY_RETENTION_MS;
    return points
      .filter(point => point.observedAt >= cutoff && point.observedAt <= now)
      .sort((a, b) => a.observedAt - b.observedAt)
      .slice(-HISTORY_LIMIT);
  }

  private async readPrevious(): Promise<{ latest?: NetworkIdentityPoint; history: NetworkIdentityPoint[] }> {
    try {
      const raw = JSON.parse(await readFile(join(this.dataDir, 'network-identity.json'), 'utf8')) as unknown;
      return validStoredState(raw);
    } catch {
      return { history: [] };
    }
  }

  private async persist(latest: NetworkIdentityPoint, history: NetworkIdentityPoint[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const path = join(this.dataDir, 'network-identity.json');
    const temp = path + '.tmp';
    const stored: StoredNetworkIdentityState = { version: 1, latest, history };
    await writeFile(temp, JSON.stringify(stored) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  }
}

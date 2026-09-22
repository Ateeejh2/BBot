import { isIP } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface NetworkIdentityPoint {
  ip: string;
  countryCode?: string;
  region?: string;
  city?: string;
  asn?: number;
  organization?: string;
  observedAt: number;
}

export type NetworkIdentityRiskLevel = 'Safe' | 'Cauction' | 'Warning' | 'Dangerous' | 'Unknown';

export interface NetworkIdentityChanges {
  ip: boolean;
  asn: boolean;
  country: boolean;
  region: boolean;
  city: boolean;
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
  changes?: NetworkIdentityChanges;
  risk: NetworkIdentityRisk;
  checkedAt?: number;
}

type LookupResult = Omit<NetworkIdentityPoint, 'observedAt'>;
export type NetworkIdentityLookup = (signal: AbortSignal) => Promise<LookupResult>;

export function assessNetworkIdentityRisk(
  previous: NetworkIdentityPoint | undefined,
  current: NetworkIdentityPoint | undefined
): { changes?: NetworkIdentityChanges; risk: NetworkIdentityRisk } {
  if (!previous || !current) return { risk: { level: 'Unknown', reasons: ['No comparable previous network identity'] } };

  const changes: NetworkIdentityChanges = {
    ip: previous.ip !== current.ip,
    asn: previous.asn !== undefined && current.asn !== undefined && previous.asn !== current.asn,
    country: previous.countryCode !== undefined && current.countryCode !== undefined && previous.countryCode !== current.countryCode,
    region: previous.region !== undefined && current.region !== undefined && previous.region !== current.region,
    city: previous.city !== undefined && current.city !== undefined && previous.city !== current.city
  };

  let score = 0;
  const reasons: string[] = [];
  if (changes.ip) { score += 25; reasons.push('Public IP changed (+25)'); }
  if (changes.asn) { score += 30; reasons.push('ASN changed (+30)'); }
  if (changes.country) { score += 55; reasons.push('Country changed (+55)'); }
  if (changes.region) { score += 15; reasons.push('Region changed (+15)'); }
  if (changes.city) { score += 5; reasons.push('City changed (+5)'); }
  score = Math.min(100, score);

  const level: NetworkIdentityRiskLevel =
    score >= 70 ? 'Dangerous' :
    score >= 45 ? 'Warning' :
    score >= 20 ? 'Cauction' :
    'Safe';

  if (!reasons.length) reasons.push('No monitored network identity changes');
  return { changes, risk: { score, level, reasons } };
}

const textField = (value: unknown, max = 160): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;

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
  const asn = typeof connection?.asn === 'number' && Number.isSafeInteger(connection.asn) && connection.asn > 0
    ? connection.asn
    : undefined;

  return {
    ip,
    countryCode: textField(value.country_code, 8),
    region: textField(value.region, 100),
    city: textField(value.city, 100),
    asn,
    organization: textField(connection?.org, 160)
  };
}

function validStoredPoint(value: unknown): NetworkIdentityPoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.ip !== 'string' || !isIP(raw.ip) || typeof raw.observedAt !== 'number' || !Number.isFinite(raw.observedAt)) return;
  const asn = typeof raw.asn === 'number' && Number.isSafeInteger(raw.asn) && raw.asn > 0 ? raw.asn : undefined;
  return {
    ip: raw.ip,
    observedAt: raw.observedAt,
    countryCode: textField(raw.countryCode, 8),
    region: textField(raw.region, 100),
    city: textField(raw.city, 100),
    asn,
    organization: textField(raw.organization, 160)
  };
}

export class NetworkIdentityMonitor {
  private value: NetworkIdentitySnapshot = { status: 'CHECKING', changed: false, risk: { level: 'Unknown', reasons: ['Checking network identity'] } };
  private baseline?: NetworkIdentityPoint;
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
      previous: this.value.previous ? { ...this.value.previous } : undefined
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
        this.baseline = await this.readPrevious();
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
        const assessed = assessNetworkIdentityRisk(previous, current);
        const changed = Boolean(assessed.changes && Object.values(assessed.changes).some(Boolean));
        this.value = {
          status: 'OK',
          current,
          previous,
          changed,
          changes: assessed.changes,
          risk: assessed.risk,
          checkedAt: now
        };
        this.onChange();
        try { await this.persist(current); } catch { /* Display remains valid even if persistence fails. */ }
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
          risk: { level: 'Unknown', reasons: ['Current network identity lookup failed'] },
          checkedAt: Date.now()
        };
        this.onChange();
      }
    } finally {
      this.running = false;
    }
  }

  private async readPrevious(): Promise<NetworkIdentityPoint | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(this.dataDir, 'network-identity.json'), 'utf8')) as unknown;
      return validStoredPoint(raw);
    } catch {
      return undefined;
    }
  }

  private async persist(point: NetworkIdentityPoint): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const path = join(this.dataDir, 'network-identity.json');
    const temp = path + '.tmp';
    await writeFile(temp, JSON.stringify(point) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  }
}

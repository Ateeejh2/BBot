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

export interface NetworkIdentitySnapshot {
  status: 'CHECKING' | 'OK' | 'UNAVAILABLE';
  current?: NetworkIdentityPoint;
  previous?: NetworkIdentityPoint;
  changed: boolean;
  checkedAt?: number;
}

type LookupResult = Omit<NetworkIdentityPoint, 'observedAt'>;
export type NetworkIdentityLookup = (signal: AbortSignal) => Promise<LookupResult>;

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
  private value: NetworkIdentitySnapshot = { status: 'CHECKING', changed: false };
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
        const changed = Boolean(previous && (
          previous.ip !== current.ip ||
          (previous.asn !== undefined && current.asn !== undefined && previous.asn !== current.asn) ||
          (previous.countryCode !== undefined && current.countryCode !== undefined && previous.countryCode !== current.countryCode)
        ));
        this.value = { status: 'OK', current, previous, changed, checkedAt: now };
        await this.persist(current);
        this.onChange();
      } finally {
        clearTimeout(timeout);
        if (this.controller === controller) this.controller = undefined;
      }
    } catch {
      if (!this.closed) {
        this.value = { status: 'UNAVAILABLE', previous: this.baseline, changed: false, checkedAt: Date.now() };
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

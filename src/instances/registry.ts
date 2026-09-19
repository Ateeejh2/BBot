import { instanceKey, type ReturnReason } from '../core/types.js';
export interface InstanceRecord {
  id: string; bots: Set<string>; firstSeen: number; lastSeen: number;
  status: 'ACTIVE' | 'SUSPECT' | 'INACTIVE'; lastBotLeftAt?: number;
  metadata: Record<string, unknown>;
}
export class InstanceRegistry {
  readonly records = new Map<string, InstanceRecord>();
  private departures = new Map<string, Map<string, number>>();
  constructor(private readonly maxRecords = 1000, private readonly correlationMs = 10000) {}
  observe(id: string, now: number): InstanceRecord {
    id = instanceKey(id);
    let record = this.records.get(id);
    if (!record) {
      if (this.records.size >= this.maxRecords) {
        const oldest = [...this.records.values()].filter(r => !r.bots.size && r.status === 'INACTIVE').sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (!oldest) throw new Error('Instance registry capacity reached');
        this.records.delete(oldest.id); this.departures.delete(oldest.id);
      }
      record = { id, bots: new Set(), firstSeen: now, lastSeen: now, status: 'ACTIVE', metadata: {} };
      this.records.set(id, record);
    }
    record.lastSeen = now; record.status = 'ACTIVE';
    return record;
  }
  join(id: string, bot: string, now: number): void {
    this.leave(bot, now, 'PLANNED');
    this.observe(id, now).bots.add(bot);
  }
  leave(bot: string, now: number, reason: ReturnReason | 'DISCONNECT'): void {
    for (const record of this.records.values()) {
      if (!record.bots.delete(bot)) continue;
      if (!record.bots.size) record.lastBotLeftAt = now;
      if (reason === 'AFK' || reason === 'PLANNED') continue;
      const recent = this.departures.get(record.id) ?? new Map<string, number>();
      for (const [id, at] of recent) if (now - at > this.correlationMs) recent.delete(id);
      recent.set(bot, now); this.departures.set(record.id, recent);
      if (recent.size >= 2) record.status = 'SUSPECT';
    }
  }
  maintain(now: number, suspectMs: number, inactiveMs: number): void {
    for (const record of this.records.values()) {
      // Occupancy is refreshed by the manager only while membership is confirmed.
      if (!record.bots.size) {
        const age = now - record.lastSeen;
        if (age >= inactiveMs) record.status = 'INACTIVE';
        else if (age >= suspectMs) record.status = 'SUSPECT';
      }
    }
    for (const [id, recent] of this.departures) {
      for (const [bot, at] of recent) if (now - at > this.correlationMs) recent.delete(bot);
      if (!recent.size) this.departures.delete(id);
    }
  }
  heartbeat(id: string, now: number): void {
    const record = this.records.get(instanceKey(id));
    if (record) record.lastSeen = now; // Never clear correlated SUSPECT on a heartbeat.
  }
  restore(records: Array<Omit<InstanceRecord, 'bots'>>): void {
    for (const record of records.slice(-this.maxRecords)) this.records.set(record.id, { ...record, bots: new Set(), status: 'SUSPECT' });
  }
  snapshot(): Array<Omit<InstanceRecord, 'bots'>> {
    return [...this.records.values()].map(({ bots: _bots, ...record }) => record);
  }
}

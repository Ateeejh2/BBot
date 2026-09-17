import type { BotView } from '../core/types.js';
import { backoff } from '../recovery/backoff.js';
import type { InstanceRegistry } from './registry.js';
export class DistributionManager {
  private attempts = new Map<string, { count: number; nextAt: number }>();
  constructor(private maxAttempts: number, private cooldownMs: number) {}
  choose(bots: BotView[], registry: InstanceRegistry, now: number): BotView | undefined {
    const active = [...registry.records.values()].filter(r => r.status === 'ACTIVE');
    if (active.length < 2) return;
    const total = active.reduce((sum, r) => sum + r.bots.size, 0);
    const ceiling = Math.ceil(total / active.length);
    const minimum = Math.min(...active.map(r => r.bots.size));
    const crowded = active.filter(r => r.bots.size > ceiling && r.bots.size - minimum > 1).sort((a, b) => b.bots.size - a.bots.size);
    for (const record of crowded) {
      const bot = bots.find(b => b.instanceId === record.id && b.state === 'IN_PIT_IDLE' &&
        (this.attempts.get(b.id)?.count ?? 0) < this.maxAttempts && (this.attempts.get(b.id)?.nextAt ?? 0) <= now);
      if (bot) return bot;
    }
  }
  recordAttempt(botId: string, now: number): void {
    const count = this.attempts.get(botId)?.count ?? 0;
    this.attempts.set(botId, { count: count + 1, nextAt: now + backoff(count, { baseMs: this.cooldownMs, maxMs: this.cooldownMs * 16, jitter: 0.25 }) });
  }
  // Budgets deliberately do not auto-reset: no endless quest for perfect balance.
}

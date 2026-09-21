import type { BotView } from '../core/types.js';
import { backoff } from '../recovery/backoff.js';
import type { InstanceRegistry } from './registry.js';

export class DistributionManager {
  private attempts = new Map<string, { count: number; nextAt: number }>();

  constructor(private maxAttempts: number, private cooldownMs: number) {}

  choose(bots: BotView[], _registry: InstanceRegistry, now: number): BotView | undefined {
    // Coverage-first distribution: while two or more bots share one confirmed
    // Pit instance, reroll only one idle duplicate. This keeps unique instance
    // coverage growing instead of considering e.g. 5/5 across two instances
    // "balanced" when more Pit instances may be available.
    const occupied = new Map<string, BotView[]>();
    for (const bot of bots) {
      if (!bot.instanceId) continue;
      const list = occupied.get(bot.instanceId) ?? [];
      list.push(bot);
      occupied.set(bot.instanceId, list);
    }

    const duplicated = [...occupied.values()]
      .filter(group => group.length > 1)
      .sort((a, b) => b.length - a.length || (a[0]?.instanceId ?? '').localeCompare(b[0]?.instanceId ?? ''));

    for (const group of duplicated) {
      const eligible = group
        .filter(bot => bot.state === 'IN_PIT_IDLE')
        .filter(bot => {
          const attempt = this.attempts.get(bot.id);
          return (attempt?.count ?? 0) < this.maxAttempts && (attempt?.nextAt ?? 0) <= now;
        })
        // Prefer rerolling a bot that has already been moving around. That keeps
        // the long-lived resident stable if a rerolled bot lands on it.
        .sort((a, b) => {
          const aa = this.attempts.get(a.id)?.count ?? 0;
          const bb = this.attempts.get(b.id)?.count ?? 0;
          if (aa !== bb) return bb - aa;
          return b.id.localeCompare(a.id, undefined, { numeric: true });
        });
      if (eligible[0]) return eligible[0];
    }
  }

  recordAttempt(botId: string, now: number): void {
    const count = this.attempts.get(botId)?.count ?? 0;
    this.attempts.set(botId, {
      count: count + 1,
      nextAt: now + backoff(count, {
        baseMs: this.cooldownMs,
        maxMs: this.cooldownMs * 16,
        jitter: 0.25
      })
    });
  }

  // Attempts are intentionally bounded per process lifetime. This prevents a
  // small set of available Pit instances from causing endless lobby hopping.
}

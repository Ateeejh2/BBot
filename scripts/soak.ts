import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config/index.js';
import { BotManager } from '../src/bot/manager.js';
import { MockTransport } from '../src/bot/mock.js';
import { InstanceRegistry } from '../src/instances/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { PathfindingController } from '../src/pathfinding/controller.js';
import { MockTaskHandler } from '../src/events/task.js';
import { Logger } from '../src/logging/logger.js';
const seconds = Number(process.env.SOAK_SECONDS ?? '10');
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new Error('SOAK_SECONDS must be 1..86400');
// Synthetic clients only. Uses accelerated logical time, never Minecraft sockets.
const config = loadConfig({ BOT_COUNT: '20', CONNECTION_SPACING_MS: '100', PLAY_COOLDOWN_MS: '1000' });
let now = Date.now(); let nextInstance = 0;
const registry = new InstanceRegistry(100);
const scheduler = new Scheduler(3, 200, 100);
const paths = new PathfindingController(2, 1000);
const manager = new BotManager(config, (_i, events) => new MockTransport(events, () => `mock-${nextInstance++ % 7}`), registry, scheduler, paths, new MockTaskHandler(), new Logger('error'), () => now);
const started = performance.now(); const cpu = process.cpuUsage(); const startHeap = process.memoryUsage().heapUsed;
let iterations = 0; let maxActive = 0; let recoveries = 0; let accepted = 0; let completed = 0;
const seenCompleted = new Set<string>();
try {
  while (performance.now() - started < seconds * 1000) {
    now += 100;
    if (iterations % 10 === 0) for (const r of registry.records.values()) {
      if (scheduler.enqueue({ id: `event-${iterations}-${r.id}`, instanceId: r.id, target: { x: 5, y: 64, z: 5 }, type: 'mock', expiresAt: now + 5000 }, now)) accepted++;
    }
    if (iterations % 30 === 0) {
      const bot = manager.views().find(b => b.instanceId);
      if (bot) { manager.notifyLobbyReturn(bot.id); recoveries++; }
    }
    manager.tick(); maxActive = Math.max(maxActive, paths.active);
    for (const j of scheduler.jobs.values()) if (j.state === 'COMPLETED' && !seenCompleted.has(j.id)) { completed++; seenCompleted.add(j.id); }
    for (const id of seenCompleted) if (!scheduler.jobs.has(id)) seenCompleted.delete(id);
    assert.ok(paths.active <= 2); assert.ok(scheduler.jobs.size <= 200); assert.ok(registry.records.size <= 100);
    iterations++; await delay(5);
  }
} finally { manager.stop(); }
await delay(25);
assert.equal(paths.active, 0); assert.equal(paths.queued, 0); assert.ok(completed > 0);
const used = process.cpuUsage(cpu);
console.log(JSON.stringify({ mode: 'mock-only', seconds, iterations, accepted, completed, recoveries, maxActive,
  jobsRetained: scheduler.jobs.size, instancesRetained: registry.records.size,
  heapStartBytes: startHeap, heapEndBytes: process.memoryUsage().heapUsed, rssBytes: process.memoryUsage().rss,
  cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000,
  note: 'Short synthetic check, not a live-client capacity benchmark or leak proof.' }, null, 2));

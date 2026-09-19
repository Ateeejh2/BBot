import { performance } from 'node:perf_hooks';
import type { Config } from '../config/index.js';
import { BotManager } from '../bot/manager.js';
import type { EventProvider } from '../events/provider.js';
import type { JsonStore } from './store.js';
import type { Logger } from '../logging/logger.js';
import { carePackageRefreshMs, type CarePackageSchedule } from '../events/brooke.js';
export class Application {
  private timer?: ReturnType<typeof setInterval>;
  private lifetime = new AbortController();
  private polling?: Promise<void>;
  private carePolling?: Promise<void>;
  private saving?: Promise<void>;
  private nextPoll = 0; private nextCarePoll = 0; private nextSave = 0; private nextMetrics = 0;
  private cpu = process.cpuUsage(); private metricsAt = performance.now();
  constructor(private manager: BotManager, private provider: EventProvider,
    private store: JsonStore, private logger: Logger, private config: Config,
    private carePackages?: CarePackageSchedule) {}
  async start(): Promise<void> {
    const snapshot = await this.store.load();
    if (snapshot) { this.manager.scheduler.restore(snapshot.jobs, Date.now()); this.manager.registry.restore(snapshot.instances); }
    this.timer = setInterval(() => this.tick(), 250);
    this.tick();
  }
  private tick(): void {
    if (this.lifetime.signal.aborted) return;
    const now = Date.now();
    try { this.manager.tick(); }
    catch { this.logger.log('error', 'manager invariant failure; stopping'); void this.stop(); process.exitCode = 1; return; }
    if (!this.polling && now >= this.nextPoll) {
      this.nextPoll = now + this.config.eventPollMs;
      this.polling = this.provider.fetchEvents(this.lifetime.signal).then(events => {
        if (this.lifetime.signal.aborted) return;
        let accepted = 0;
        for (const event of events) if (this.manager.scheduler.enqueue(event, Date.now())) accepted++;
        this.logger.log('debug', 'event poll completed', { fetched: events.length, accepted });
      }).catch(() => { if (!this.lifetime.signal.aborted) this.logger.log('warn', 'event fetch failed; retry on next poll'); })
        .finally(() => { this.polling = undefined; });
    }
    if (this.carePackages && !this.carePolling && now >= this.nextCarePoll) {
      this.nextCarePoll = now + carePackageRefreshMs;
      this.carePolling = this.carePackages.refresh()
        .catch(() => { if (!this.lifetime.signal.aborted) this.logger.log('warn', 'Care Package schedule refresh failed; using last good data'); })
        .finally(() => { this.carePolling = undefined; });
    }
    if (!this.saving && now >= this.nextSave) {
      this.nextSave = now + 5000;
      this.saving = this.persist().catch(() => this.logger.log('error', 'state snapshot write failed')).finally(() => { this.saving = undefined; });
    }
    if (now >= this.nextMetrics) {
      this.nextMetrics = now + 60000;
      const cpu = process.cpuUsage(this.cpu); const elapsed = performance.now() - this.metricsAt;
      this.logger.log('info', 'runtime metrics', { rssBytes: process.memoryUsage().rss, heapBytes: process.memoryUsage().heapUsed,
        cpuPercent: (cpu.user + cpu.system) / (elapsed * 1000) * 100,
        jobs: this.manager.scheduler.jobs.size, observedInstances: this.manager.registry.records.size,
        pathsActive: this.manager.paths.active, pathsQueued: this.manager.paths.queued });
      this.cpu = process.cpuUsage(); this.metricsAt = performance.now();
    }
  }
  private persist(): Promise<void> {
    return this.store.save({ version: 1, jobs: this.manager.scheduler.snapshot(), instances: this.manager.registry.snapshot() });
  }
  async stop(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(); if (this.timer) clearInterval(this.timer);
    this.manager.stop();
    await this.saving; await this.carePolling;
    try { await this.persist(); } catch { this.logger.log('error', 'final snapshot failed'); process.exitCode = 1; }
    this.logger.log('info', 'BBot stopped');
  }
}

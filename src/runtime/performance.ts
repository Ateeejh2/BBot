import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface RuntimePerformanceSnapshot {
  cpuPercent: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  eventLoopMeanMs: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  uptimeSeconds: number;
}

/** Lightweight process diagnostics sampled with the management snapshot cadence. */
export class RuntimePerformanceMonitor {
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private cpuAt = process.hrtime.bigint();
  private cpuUsage = process.cpuUsage();
  private cpuPercent = 0;
  private eventLoopMeanMs = 0;
  private eventLoopP99Ms = 0;
  private eventLoopMaxMs = 0;

  constructor() { this.loop.enable(); }

  snapshot(): RuntimePerformanceSnapshot {
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - this.cpuAt) / 1000;
    if (elapsedUs >= 250_000) {
      const delta = process.cpuUsage(this.cpuUsage);
      this.cpuPercent = ((delta.user + delta.system) / elapsedUs) * 100;
      this.cpuAt = now;
      this.cpuUsage = process.cpuUsage();

      const mean = this.loop.mean / 1_000_000;
      const p99 = this.loop.percentile(99) / 1_000_000;
      const max = this.loop.max / 1_000_000;
      if (Number.isFinite(mean)) this.eventLoopMeanMs = mean;
      if (Number.isFinite(p99)) this.eventLoopP99Ms = p99;
      if (Number.isFinite(max)) this.eventLoopMaxMs = max;
      this.loop.reset();
    }

    const memory = process.memoryUsage();
    const oneDecimal = (value: number) => Math.round(value * 10) / 10;
    return {
      cpuPercent: oneDecimal(Math.max(0, this.cpuPercent)),
      rssMb: oneDecimal(memory.rss / 1024 / 1024),
      heapUsedMb: oneDecimal(memory.heapUsed / 1024 / 1024),
      heapTotalMb: oneDecimal(memory.heapTotal / 1024 / 1024),
      eventLoopMeanMs: oneDecimal(Math.max(0, this.eventLoopMeanMs)),
      eventLoopP99Ms: oneDecimal(Math.max(0, this.eventLoopP99Ms)),
      eventLoopMaxMs: oneDecimal(Math.max(0, this.eventLoopMaxMs)),
      uptimeSeconds: Math.floor(process.uptime())
    };
  }

  close(): void { this.loop.disable(); }
}

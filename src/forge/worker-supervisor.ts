import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Config } from '../config/index.js';
import type { Logger } from '../logging/logger.js';

export type ForgeWorkerPhase = 'STOPPED' | 'LAUNCHING' | 'LAUNCHED' | 'STOPPING';

export interface ForgeWorkerView {
  botId: string;
  phase: ForgeWorkerPhase;
  bridgePort: number;
  lastError?: string;
  /** Aggregate CPU usage for the HeadlessMC/Minecraft process group. 100% = one full CPU core. */
  cpuPercent?: number;
  /** Aggregate resident memory for the HeadlessMC/Minecraft process group. */
  rssMb?: number;
  processCount?: number;
}

interface WorkerResourceSample {
  at: number;
  cpuTicks: number;
  cpuPercent: number;
  rssMb: number;
  processCount: number;
}

interface WorkerRecord extends ForgeWorkerView {
  child?: ChildProcessWithoutNullStreams;
  resourceSample?: WorkerResourceSample;
}

const LAUNCH_COMMAND = 'launch forge:1.8.9 -specifics -lwjgl --jvm "-Djava.awt.headless=true -Xms128m -Xmx512m"\n';

function processGroupSample(groupId: number): { cpuTicks: number; rssMb: number; processCount: number } | undefined {
  if (process.platform !== 'linux') return undefined;
  let cpuTicks = 0;
  let rssKb = 0;
  let processCount = 0;

  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return undefined; }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      // fields starts at proc stat field 3 (state): pgrp=field 5, utime=14, stime=15.
      if (Number(fields[2]) !== groupId) continue;
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      if (Number.isFinite(utime)) cpuTicks += utime;
      if (Number.isFinite(stime)) cpuTicks += stime;

      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (rss) rssKb += Number(rss[1]);
      processCount++;
    } catch {
      // Processes can disappear while /proc is being sampled.
    }
  }

  return processCount ? { cpuTicks, rssMb: rssKb / 1024, processCount } : undefined;
}

const LINUX_CLOCK_TICKS = 100;

function java8Home(config: Config): string | undefined {
  if (config.forge.java8Home && existsSync(join(config.forge.java8Home, 'bin', 'java'))) return config.forge.java8Home;
  const candidates = [
    '/usr/local/sdkman/candidates/java',
    join(homedir(), '.sdkman', 'candidates', 'java')
  ];
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    try {
      const match = readdirSync(root)
        .filter(name => /^8(?:\.|$)/.test(name))
        .find(name => existsSync(join(root, name, 'bin', 'java')));
      if (match) return join(root, match);
    } catch { /* Try the next location. */ }
  }
  return undefined;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    child.once('exit', onExit);
  });
}

export class ForgeWorkerSupervisor {
  private workers = new Map<string, WorkerRecord>();

  constructor(private config: Config, private logger: Logger) {
    for (let i = 0; i < config.count; i++) {
      const botId = `bot-${i + 1}`;
      this.workers.set(botId, {
        botId,
        phase: 'STOPPED',
        bridgePort: config.forge.bridgeBasePort + i
      });
    }
  }

  snapshot(): ForgeWorkerView[] {
    const now = Date.now();
    return [...this.workers.values()].map(worker => {
      const childPid = worker.child?.pid;
      let resource: Pick<ForgeWorkerView, 'cpuPercent' | 'rssMb' | 'processCount'> = {};
      if (childPid && worker.phase !== 'STOPPED') {
        const raw = processGroupSample(childPid);
        if (raw) {
          const previous = worker.resourceSample;
          let cpuPercent = previous?.cpuPercent ?? 0;
          if (previous && now > previous.at && raw.cpuTicks >= previous.cpuTicks) {
            const elapsedSeconds = (now - previous.at) / 1000;
            cpuPercent = ((raw.cpuTicks - previous.cpuTicks) / LINUX_CLOCK_TICKS / elapsedSeconds) * 100;
          }
          const oneDecimal = (value: number) => Math.round(value * 10) / 10;
          worker.resourceSample = {
            at: now,
            cpuTicks: raw.cpuTicks,
            cpuPercent: oneDecimal(Math.max(0, cpuPercent)),
            rssMb: oneDecimal(Math.max(0, raw.rssMb)),
            processCount: raw.processCount
          };
          resource = {
            cpuPercent: worker.resourceSample.cpuPercent,
            rssMb: worker.resourceSample.rssMb,
            processCount: worker.resourceSample.processCount
          };
        }
      }
      const { botId, phase, bridgePort, lastError } = worker;
      return { botId, phase, bridgePort, ...(lastError ? { lastError } : {}), ...resource };
    });
  }

  isLaunched(botId: string): boolean {
    return this.worker(botId).phase === 'LAUNCHED';
  }

  async launch(botId: string): Promise<void> {
    const worker = this.worker(botId);
    if (worker.phase !== 'STOPPED') throw Error('INVALID_STATE');

    // The current PoC uses one shared HeadlessMC game directory. Prevent concurrent
    // launches until per-worker runtime directories are introduced.
    if ([...this.workers.values()].some(other => other.botId !== botId && other.phase !== 'STOPPED')) {
      throw Error('WORKER_RUNTIME_BUSY');
    }

    const script = join(this.config.forge.pocDir, 'scripts', 'run-hmc.sh');
    if (!existsSync(script)) throw Error('WORKER_NOT_BOOTSTRAPPED');

    worker.phase = 'LAUNCHING';
    worker.lastError = undefined;
    worker.resourceSample = undefined;

    const env: NodeJS.ProcessEnv = { ...process.env, BBOT_POC_BRIDGE_PORT: String(worker.bridgePort), BBOT_POC_AUTOTEST: 'false' };
    const resolvedJava8 = java8Home(this.config);
    if (resolvedJava8) env.JAVA8_HOME = resolvedJava8;

    const child = spawn(script, [], {
      cwd: this.config.forge.pocDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    worker.child = child;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let output = '';

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };

      const fail = (code: string) => {
        worker.lastError = code;
        finish(new Error(code));
      };

      const inspect = (chunk: Buffer | string) => {
        output += chunk.toString();
        if (output.length > 32_768) output = output.slice(-16_384);
        const marker = `bridge listening on 127.0.0.1:${worker.bridgePort}`;
        if (!output.includes(marker)) return;
        worker.phase = 'LAUNCHED';
        worker.lastError = undefined;
        this.logger.log('info', 'forge worker launched', { botId, bridgePort: worker.bridgePort });
        finish();
      };

      const timer = setTimeout(() => {
        fail('WORKER_LAUNCH_TIMEOUT');
        void this.forceStop(worker);
      }, 120_000);

      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('error', () => {
        worker.child = undefined;
        worker.resourceSample = undefined;
        worker.phase = 'STOPPED';
        fail('WORKER_LAUNCH_FAILED');
      });
      child.once('exit', () => {
        const wasLaunching = worker.phase === 'LAUNCHING';
        worker.child = undefined;
        worker.resourceSample = undefined;
        worker.phase = 'STOPPED';
        this.logger.log('info', 'forge worker stopped', { botId, bridgePort: worker.bridgePort });
        if (wasLaunching) fail(worker.lastError ?? 'WORKER_LAUNCH_FAILED');
      });

      setTimeout(() => {
        if (child.stdin.destroyed || !child.stdin.writable) {
          fail('WORKER_LAUNCH_FAILED');
          return;
        }
        child.stdin.write(LAUNCH_COMMAND);
      }, 250).unref();
    });
  }

  async quit(botId: string): Promise<void> {
    const worker = this.worker(botId);
    if (worker.phase !== 'LAUNCHED') throw Error(worker.phase === 'STOPPING' ? 'CONFLICT' : 'INVALID_STATE');

    worker.phase = 'STOPPING';
    const child = worker.child;
    if (!child) {
      worker.phase = 'STOPPED';
      return;
    }

    try {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write('quit\n');
    } catch { /* Escalate below if the process does not exit. */ }

    if (!(await waitForExit(child, 5000))) {
      this.killGroup(child, 'SIGTERM');
      if (!(await waitForExit(child, 3000))) this.killGroup(child, 'SIGKILL');
    }
    worker.child = undefined;
    worker.resourceSample = undefined;
    worker.phase = 'STOPPED';
    worker.lastError = undefined;
  }

  async close(): Promise<void> {
    for (const worker of this.workers.values()) {
      if (worker.phase === 'STOPPED') continue;
      try { await this.quit(worker.botId); } catch { await this.forceStop(worker); }
    }
  }

  private worker(botId: string): WorkerRecord {
    const worker = this.workers.get(botId);
    if (!worker) throw Error('UNKNOWN_BOT');
    return worker;
  }

  private killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* Process may already be gone. */ }
  }

  private async forceStop(worker: WorkerRecord): Promise<void> {
    const child = worker.child;
    if (child) {
      this.killGroup(child, 'SIGTERM');
      if (!(await waitForExit(child, 3000))) this.killGroup(child, 'SIGKILL');
    }
    worker.child = undefined;
    worker.resourceSample = undefined;
    worker.phase = 'STOPPED';
  }
}

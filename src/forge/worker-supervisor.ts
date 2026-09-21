import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Config } from '../config/index.js';
import type { Logger } from '../logging/logger.js';
import type { SessionCredential } from '../runtime/session.js';

export type ForgeWorkerPhase = 'STOPPED' | 'LAUNCHING' | 'LAUNCHED' | 'STOPPING';

export interface ForgeWorkerView {
  botId: string;
  phase: ForgeWorkerPhase;
  bridgePort: number;
  lastError?: string;
  /** Aggregate CPU usage for the HeadlessMC/Minecraft process tree. 100% = one full CPU core. */
  cpuPercent?: number;
  /** Aggregate resident memory for the HeadlessMC/Minecraft process tree. */
  rssMb?: number;
  processCount?: number;
  /** Observed Forge startup milestone, 0..100. Present while launching and at ready. */
  launchProgress?: number;
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
  sessionFile?: string;
}

const LAUNCH_COMMAND = 'launch forge:1.8.9 -offline -specifics -lwjgl --jvm "-Djava.awt.headless=true -Xms128m -Xmx512m"\n';

function processTreeSample(rootPid: number): { cpuTicks: number; rssMb: number; processCount: number } | undefined {
  if (process.platform !== 'linux') return undefined;

  let entries: string[];
  try { entries = readdirSync('/proc'); } catch { return undefined; }

  const records = new Map<number, { ppid: number; cpuTicks: number; rssKb: number }>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const pid = Number(entry);
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      // fields starts at proc stat field 3 (state): ppid=field 4, utime=14, stime=15.
      const ppid = Number(fields[1]);
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      if (!Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime)) continue;

      const status = readFileSync(`/proc/${entry}/status`, 'utf8');
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      records.set(pid, { ppid, cpuTicks: utime + stime, rssKb: rss ? Number(rss[1]) : 0 });
    } catch {
      // Processes can disappear while /proc is being sampled.
    }
  }

  if (!records.has(rootPid)) return undefined;
  const included = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, record] of records) {
      if (!included.has(pid) && included.has(record.ppid)) {
        included.add(pid);
        changed = true;
      }
    }
  }

  let cpuTicks = 0;
  let rssKb = 0;
  for (const pid of included) {
    const record = records.get(pid);
    if (!record) continue;
    cpuTicks += record.cpuTicks;
    rssKb += record.rssKb;
  }
  return { cpuTicks, rssMb: rssKb / 1024, processCount: included.size };
}

function linuxClockTicks(): number {
  if (process.platform !== 'linux') return 100;
  try {
    const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
    const value = Number(result.stdout.trim());
    if (result.status === 0 && Number.isFinite(value) && value > 0) return value;
  } catch {
    // Fall back to Linux's common USER_HZ value.
  }
  return 100;
}

const LINUX_CLOCK_TICKS = linuxClockTicks();

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
    // Launch credentials are short-lived copies. A previous backend crash may
    // have left one behind, so clear the entire ephemeral worker credential area
    // before accepting any new Launch request.
    try { rmSync(join(config.authDir,'forge-workers'),{recursive:true,force:true}); } catch {}
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
        const raw = processTreeSample(childPid);
        if (raw) {
          const previous = worker.resourceSample;
          const elapsedMs = previous ? now - previous.at : 0;
          let cpuPercent = previous?.cpuPercent ?? 0;
          let sampleAt = previous?.at ?? now;
          let sampleTicks = previous?.cpuTicks ?? raw.cpuTicks;
          if (!previous || (elapsedMs >= 250 && raw.cpuTicks >= previous.cpuTicks)) {
            if (previous && elapsedMs > 0) {
              const elapsedSeconds = elapsedMs / 1000;
              cpuPercent = ((raw.cpuTicks - previous.cpuTicks) / LINUX_CLOCK_TICKS / elapsedSeconds) * 100;
            }
            sampleAt = now;
            sampleTicks = raw.cpuTicks;
          }
          const oneDecimal = (value: number) => Math.round(value * 10) / 10;
          worker.resourceSample = {
            at: sampleAt,
            cpuTicks: sampleTicks,
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
      const { botId, phase, bridgePort, lastError, launchProgress } = worker;
      return { botId, phase, bridgePort, ...(lastError ? { lastError } : {}),
        ...(launchProgress !== undefined ? { launchProgress } : {}), ...resource };
    });
  }

  isLaunched(botId: string): boolean {
    return this.worker(botId).phase === 'LAUNCHED';
  }

  isStopped(botId:string):boolean {
    return this.worker(botId).phase === 'STOPPED';
  }

  async launch(botId: string, credential:SessionCredential): Promise<void> {
    const worker = this.worker(botId);
    if (worker.phase !== 'STOPPED') throw Error('INVALID_STATE');

    const script = join(this.config.forge.pocDir, 'scripts', 'run-hmc.sh');
    if (!existsSync(script)) throw Error('WORKER_NOT_BOOTSTRAPPED');
    if (!credential || typeof credential.accessToken !== 'string' || credential.accessToken.length < 1 ||
        credential.accessToken.length > 2048 || !/^[A-Za-z0-9_]{1,16}$/.test(credential.selectedProfile?.name ?? '') ||
        !/^[0-9a-f]{32}$/i.test(credential.selectedProfile?.id ?? '')) throw Error('AUTH_FAILED');

    // Claim this slot before any filesystem await so two Launch requests for
    // the same bot cannot race into two Minecraft processes.
    worker.phase = 'LAUNCHING';
    worker.lastError = undefined;
    worker.resourceSample = undefined;
    worker.launchProgress = 5;

    const runtimeDir=join(this.config.dataDir,'forge-workers',botId);
    const sessionDir=join(this.config.authDir,'forge-workers',botId);
    const sessionFile=join(sessionDir,'session.json');
    const temp=`${sessionFile}.${randomUUID()}.tmp`;
    worker.sessionFile=sessionFile;

    let child:ChildProcessWithoutNullStreams;
    try{
      await mkdir(runtimeDir,{recursive:true,mode:0o700});
      await mkdir(sessionDir,{recursive:true,mode:0o700});
      await rm(sessionFile,{force:true});
      await writeFile(temp,JSON.stringify({
        accessToken:credential.accessToken,
        selectedProfile:{name:credential.selectedProfile.name,id:credential.selectedProfile.id.toLowerCase()}
      }),{encoding:'utf8',mode:0o600,flag:'wx'});
      await rename(temp,sessionFile);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        BBOT_POC_BRIDGE_PORT: String(worker.bridgePort),
        BBOT_POC_AUTOTEST: 'false',
        BBOT_HMC_RUNTIME: runtimeDir,
        BBOT_SESSION_FILE: sessionFile
      };
      const resolvedJava8 = java8Home(this.config);
      if (resolvedJava8) env.JAVA8_HOME = resolvedJava8;

      child = spawn(script, [], {
        cwd: this.config.forge.pocDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      });
      worker.child = child;
    }catch{
      await rm(temp,{force:true}).catch(()=>{});
      worker.child=undefined;
      worker.resourceSample=undefined;
      worker.launchProgress=undefined;
      worker.phase='STOPPED';
      worker.lastError='WORKER_LAUNCH_FAILED';
      await this.clearSessionFile(worker);
      throw Error('WORKER_LAUNCH_FAILED');
    }

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
        const advance = (value:number) => {
          worker.launchProgress = Math.max(worker.launchProgress ?? 0, Math.min(100, value));
        };
        advance(10);
        if (/launch\s+forge:1\.8\.9/i.test(output)) advance(30);
        if (/minecraft forge|forge mod loader|\bfml\b|forge.*1\.8\.9/i.test(output)) advance(55);
        if (/bbotheadlesspoc|bbot headless poc|\[bbotpoc\].*ready/i.test(output)) advance(85);
        const marker = `bridge listening on 127.0.0.1:${worker.bridgePort}`;
        if (!output.includes(marker)) return;
        worker.launchProgress = 100;
        worker.phase = 'LAUNCHED';
        worker.lastError = undefined;
        this.logger.log('info', 'forge worker launched', { botId, bridgePort: worker.bridgePort });
        // Do not resolve Launch until the short-lived credential copy is gone.
        // This keeps the API contract deterministic and avoids a small window
        // where a successful Launch still leaves session.json on disk.
        void this.clearSessionFile(worker).then(
          () => finish(),
          () => finish()
        );
      };

      const timer = setTimeout(() => {
        fail('WORKER_LAUNCH_TIMEOUT');
        void this.forceStop(worker);
      }, 120_000);

      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('error', () => {
        void this.clearSessionFile(worker);
        worker.child = undefined;
        worker.resourceSample = undefined;
        worker.launchProgress = undefined;
        worker.phase = 'STOPPED';
        fail('WORKER_LAUNCH_FAILED');
      });
      child.once('exit', () => {
        void this.clearSessionFile(worker);
        const wasLaunching = worker.phase === 'LAUNCHING';
        worker.child = undefined;
        worker.resourceSample = undefined;
        worker.launchProgress = undefined;
        worker.phase = 'STOPPED';
        this.logger.log('info', 'forge worker stopped', { botId, bridgePort: worker.bridgePort });
        if (wasLaunching) fail(worker.lastError ?? 'WORKER_LAUNCH_FAILED');
      });

      setTimeout(() => {
        if (child.stdin.destroyed || !child.stdin.writable) {
          fail('WORKER_LAUNCH_FAILED');
          void this.forceStop(worker);
          return;
        }
        child.stdin.write(LAUNCH_COMMAND);
        worker.launchProgress = Math.max(worker.launchProgress ?? 0, 20);
      }, 250).unref();
    });
  }

  async quit(botId: string): Promise<void> {
    const worker = this.worker(botId);
    if (worker.phase !== 'LAUNCHED') throw Error(worker.phase === 'STOPPING' ? 'CONFLICT' : 'INVALID_STATE');

    worker.phase = 'STOPPING';
    const child = worker.child;
    if (!child) {
      worker.launchProgress = undefined;
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
    worker.launchProgress = undefined;
    worker.phase = 'STOPPED';
    worker.lastError = undefined;
    await this.clearSessionFile(worker);
  }

  async close(): Promise<void> {
    for (const worker of this.workers.values()) {
      if (worker.phase === 'STOPPED') continue;
      try { await this.quit(worker.botId); } catch { await this.forceStop(worker); }
    }
  }

  private async clearSessionFile(worker:WorkerRecord):Promise<void>{
    const file=worker.sessionFile;
    worker.sessionFile=undefined;
    if(file)await rm(file,{force:true}).catch(()=>{});
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
    worker.launchProgress = undefined;
    worker.phase = 'STOPPED';
    await this.clearSessionFile(worker);
  }
}

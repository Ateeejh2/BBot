import { StateMachine, Generation } from '../core/state.js';
import { UnknownReturnClassifier, type BotView, type GameEvent, type ReturnClassifier, type ReturnReason } from '../core/types.js';
import type { Config } from '../config/index.js';
import { Logger, safeKickReason } from '../logging/logger.js';
import { parseInstance } from '../instances/parser.js';
import { InstanceRegistry } from '../instances/registry.js';
import { DistributionManager } from '../instances/distribution.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { PathfindingController } from '../pathfinding/controller.js';
import { backoff } from '../recovery/backoff.js';
import type { TaskHandler } from '../events/task.js';
import type { BotTransport, TransportFactory } from './transport.js';
interface Execution { id: string; lease: number; generation: number; abort: AbortController }
interface ManagedBot {
  id: string; accountLabel: string; accountId?: string; minecraftName?: string; machine: StateMachine; generation: Generation;
  connection: number; transport?: BotTransport; instanceId?: string; pendingInstance?: string;
  ready: boolean; dueAt: number; deadline: number; reconnectAttempts: number; joinAttempts: number; joinSpawnObserved: boolean;
  stableSince?: number; paused: boolean; authCheckPending?: boolean; execution?: Execution; lastKickReason?: string; lastKickedAt?: number;
}
export class BotManager {
  private bots: ManagedBot[];
  private stopped = false;
  private configurationLocked = false;
  private nextConnectAt = 0;
  private nextRerollAt = 0;
  private sessionFailureHandler?: (botId: string, accountId: string) => Promise<boolean>;
  readonly distribution: DistributionManager;
  constructor(readonly config: Config, private factory: TransportFactory,
    readonly registry: InstanceRegistry, readonly scheduler: Scheduler,
    readonly paths: PathfindingController, private task: TaskHandler, private logger: Logger,
    private now = Date.now, private random = Math.random,
    private classifier: ReturnClassifier = new UnknownReturnClassifier()) {
    this.distribution = new DistributionManager(config.rerollMaxAttempts, config.rerollCooldownMs);
    this.bots = config.accounts.map((a, i) => {
      const bot: ManagedBot = { id: `bot-${i + 1}`, accountLabel: a.label,
        machine: new StateMachine((_from, to) => this.log(bot, 'state changed', { state: to })),
        generation: new Generation(), connection: 0, ready: false, dueAt: 0, deadline: 0,
        reconnectAttempts: 0, joinAttempts: 0, joinSpawnObserved: false, paused: config.api.enabled };
      return bot;
    });
  }
  views(): BotView[] { return this.bots.map(b => this.view(b)); }
  setSessionFailureHandler(handler: (botId: string, accountId: string) => Promise<boolean>): void {
    this.sessionFailureHandler = handler;
  }
  pauseForAccountError(botId: string): void {
    const b = this.controlled(botId);
    b.paused = true; b.authCheckPending = false;
  }
  private controlled(id: string): ManagedBot {
    const bot = this.bots.find(b => b.id === id);
    if (!bot) throw new Error('UNKNOWN_BOT');
    return bot;
  }
  connectBot(id: string): void {
    const b = this.controlled(id);
    if (this.configurationLocked) throw new Error('CONFLICT');
    if (b.machine.state !== 'DISCONNECTED' || !b.paused || b.authCheckPending) throw new Error('INVALID_STATE');
    if (this.config.mode === 'live' && this.config.api.enabled && !b.accountId) throw new Error('ACCOUNT_REQUIRED');
    b.paused = false; b.dueAt = 0;
    const now = this.now();
    if (now >= this.nextConnectAt) {
      this.nextConnectAt = now + this.config.connectionSpacingMs;
      this.connect(b, this.bots.indexOf(b));
    }
  }
  stopAllBots(): string[] {
    const stopped: string[] = [];
    for (const b of this.bots) {
      const wasQueued = b.machine.state === 'DISCONNECTED' && !b.paused;
      b.paused = true; b.authCheckPending = false;
      if (b.machine.state !== 'DISCONNECTED') {
        stopped.push(b.id); this.disconnected(b);
      } else if (wasQueued) stopped.push(b.id);
    }
    return stopped;
  }
  joinPit(id: string): void {
    const b = this.controlled(id);
    if (b.machine.state !== 'LOBBY' || !b.ready) throw new Error('INVALID_STATE');
    this.join(b);
  }
  disconnectBot(id: string): void {
    const b = this.controlled(id);
    if (b.machine.state === 'DISCONNECTED') {
      if (!b.paused) { b.paused = true; b.authCheckPending = false; return; }
      throw new Error('INVALID_STATE');
    }
    b.paused = true; this.disconnected(b);
  }
  assignAccount(botId: string, accountId: string, account: Config['accounts'][number], minecraftName?: string): void {
    const b = this.controlled(botId);
    if (b.machine.state !== 'DISCONNECTED' || !b.paused || b.authCheckPending) throw new Error('INVALID_STATE');
    this.config.accounts[this.bots.indexOf(b)] = account;
    b.accountId = accountId; b.accountLabel = account.label; b.minecraftName = minecraftName; b.authCheckPending = false;
  }
  unassignAccount(botId: string): void {
    const b = this.controlled(botId);
    if (b.machine.state !== 'DISCONNECTED' || !b.paused || b.authCheckPending) throw new Error('INVALID_STATE');
    b.accountId = undefined; b.accountLabel = b.id; b.minecraftName = undefined; b.authCheckPending = false;
  }
  allDisconnected(): boolean { return this.bots.every(b => b.machine.state === 'DISCONNECTED'); }
  isBotStopped(id: string): boolean {
    const b = this.controlled(id);
    return b.machine.state === 'DISCONNECTED' && b.paused && !b.authCheckPending;
  }
  allStopped(): boolean { return this.bots.every(b => b.machine.state === 'DISCONNECTED' && b.paused && !b.authCheckPending); }
  async withConfigurationLock<T>(allowed: () => boolean, operation: () => Promise<T>): Promise<T> {
    if (this.configurationLocked || !allowed()) throw Error('INVALID_STATE');
    this.configurationLocked = true;
    try { return await operation(); } finally { this.configurationLocked = false; }
  }
  private view(b: ManagedBot): BotView { return { id: b.id, accountId: b.accountId, accountLabel: b.accountLabel, minecraftName: b.minecraftName, state: b.machine.state, instanceId: b.instanceId, generation: b.generation.current, position: b.transport?.position(), startQueued: b.machine.state === 'DISCONNECTED' && !b.paused, kickReason: b.lastKickReason, kickedAt: b.lastKickedAt }; }
  private log(b: ManagedBot, message: string, extra: Record<string, unknown> = {}): void {
    this.logger.log('info', message, { botId: b.id, accountLabel: b.accountLabel, instance: b.instanceId, state: b.machine.state, jobId: b.execution?.id, ...extra });
  }
  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    for (const expired of this.scheduler.expire(now)) {
      const bot = this.bots.find(b => b.id === expired.botId);
      if (bot?.execution?.id === expired.id) this.cancelExecution(bot, true);
    }
    for (const [index, b] of this.bots.entries()) {
      if (b.paused || b.authCheckPending) continue;
      if (!this.configurationLocked && b.machine.state === 'DISCONNECTED' && now >= b.dueAt && now >= this.nextConnectAt) {
        this.nextConnectAt = now + this.config.connectionSpacingMs; this.connect(b, index); continue;
      }
      if (b.machine.state === 'CONNECTING' && now >= b.deadline) { this.disconnected(b); continue; }
      if (b.machine.state === 'JOINING_PIT' && now >= b.deadline) {
        this.recover(b, 'UNKNOWN_RETURN');
        this.log(b, 'join timed out; no confirmed instance');
      }
      if (b.machine.state === 'RECOVERING' && !b.ready && now >= b.deadline) { this.disconnected(b); continue; }
      if (['LOBBY', 'RECOVERING'].includes(b.machine.state) && b.ready && now >= b.dueAt) this.join(b);
      if (b.instanceId) this.registry.heartbeat(b.instanceId, now);
      if (b.stableSince !== undefined && now - b.stableSince >= 60000) { b.reconnectAttempts = 0; b.joinAttempts = 0; }
    }
    this.registry.maintain(now, this.config.suspectMs, this.config.inactiveMs);
    for (const { job, bot } of this.scheduler.assign(this.views(), now)) {
      const managed = this.bots.find(b => b.id === bot.id)!;
      this.execute(managed, job.id, job.lease, job.event);
    }
    if (this.config.distributionEnabled && now >= this.nextRerollAt) {
      const choice = this.distribution.choose(this.views(), this.registry, now);
      if (choice) {
        const b = this.bots.find(b => b.id === choice.id)!;
        this.distribution.recordAttempt(b.id, now); this.nextRerollAt = now + this.config.rerollCooldownMs;
        this.recover(b, 'PLANNED'); b.ready = false; b.deadline = now + this.config.joinTimeoutMs;
        try { b.transport?.chat(this.config.lobbyCommand ?? '/mock-lobby'); } catch { this.disconnected(b); }
      }
    }
  }
  private checkSessionAfterConnectFailure(b: ManagedBot): void {
    const index = this.bots.indexOf(b);
    const account = this.config.accounts[index];
    const accountId = b.accountId;
    if (b.machine.state !== 'CONNECTING' || account?.kind !== 'SESSION' || !accountId ||
        !this.sessionFailureHandler || b.authCheckPending) return;
    b.authCheckPending = true;
    void this.sessionFailureHandler(b.id, accountId).then(invalid => {
      if (b.accountId !== accountId) return;
      b.authCheckPending = false;
      if (invalid) b.paused = true;
    }, () => {
      if (b.accountId === accountId) b.authCheckPending = false;
    });
  }
  private connect(b: ManagedBot, index: number): void {
    b.machine.transition('CONNECTING'); b.ready = false;
    b.deadline = this.now() + this.config.connectTimeoutMs;
    const connection = ++b.connection;
    const guard = (fn: () => void) => () => { if (!this.stopped && b.connection === connection) fn(); };
    try {
      b.transport = this.factory(index, {
        spawn: guard(() => this.spawn(b)), worldReset: guard(() => this.worldReset(b)),
        identity: username => {
          if (this.stopped || b.connection !== connection || !/^[A-Za-z0-9_]{1,16}$/.test(username)) return;
          b.minecraftName = username;
        },
        message: text => { if (!this.stopped && b.connection === connection) this.message(b, text); },
        diagnostic: (name, fields) => {
          if (this.stopped || b.connection !== connection) return;
          this.logger.log('debug', name, { botId: b.id, accountLabel: b.accountLabel,
            instance: b.instanceId, state: b.machine.state, ...fields });
        },
        kicked: (reason, loggedIn) => {
          if (this.stopped || b.connection !== connection) return;
          const kickReason = safeKickReason(reason) ?? 'Unknown kick reason';
          b.lastKickReason = kickReason; b.lastKickedAt = this.now();
          this.logger.log('warn', 'bot kicked', { botId: b.id, accountLabel: b.accountLabel,
            instance: b.instanceId, state: b.machine.state, kickReason, loggedIn: loggedIn ?? null });
          this.checkSessionAfterConnectFailure(b);
          this.disconnected(b);
        },
        end: guard(() => { this.checkSessionAfterConnectFailure(b); this.disconnected(b); }),
        error: guard(() => { this.log(b, 'transport error (details withheld)'); this.checkSessionAfterConnectFailure(b); this.disconnected(b); })
      });
    } catch { this.checkSessionAfterConnectFailure(b); this.disconnected(b); }
  }
  private confirmJoinedInstance(b: ManagedBot): void {
    if (b.machine.state !== 'JOINING_PIT' || !b.pendingInstance || !b.joinSpawnObserved) return;
    try { this.registry.join(b.pendingInstance, b.id, this.now()); }
    catch { this.log(b, 'registry full; membership rejected'); this.recover(b, 'UNKNOWN_RETURN'); return; }
    b.instanceId = b.pendingInstance; b.pendingInstance = undefined; b.joinSpawnObserved = false;
    b.machine.transition('IN_PIT_IDLE'); b.stableSince = this.now();
    this.log(b, 'instance confirmed after transfer signals');
  }
  private spawn(b: ManagedBot): void {
    b.ready = true;
    if (b.machine.state === 'CONNECTING') {
      b.machine.transition('LOBBY'); b.dueAt = this.now() + this.config.playCooldownMs;
    } else if (b.machine.state === 'JOINING_PIT') {
      // 1.8.9/Bungee event order is not assumed: require both an exact transfer notice and a spawn
      // from the same join attempt, but accept either observation order.
      b.joinSpawnObserved = true;
      this.confirmJoinedInstance(b);
    } else if (b.machine.state !== 'RECOVERING' && b.machine.state !== 'LOBBY') {
      this.recover(b, 'UNKNOWN_RETURN');
    }
  }
  private worldReset(b: ManagedBot): void {
    b.ready = false;
    if (b.machine.state === 'JOINING_PIT' || b.machine.state === 'CONNECTING') return;
    this.recover(b, 'UNKNOWN_RETURN'); b.deadline = this.now() + this.config.joinTimeoutMs;
  }
  private message(b: ManagedBot, text: string): void {
    const instance = parseInstance(text);
    if (instance && !['DISCONNECTED', 'CONNECTING'].includes(b.machine.state)) {
      if (b.machine.state !== 'JOINING_PIT') {
        this.recover(b, 'UNKNOWN_RETURN');
        b.machine.transition('JOINING_PIT');
        b.deadline = this.now() + this.config.joinTimeoutMs;
      }
      b.pendingInstance = instance;
      try { this.registry.observe(instance, this.now()); } catch { this.log(b, 'registry capacity reached'); }
      this.log(b, 'transfer destination observed', { destination: instance });
      this.confirmJoinedInstance(b);
    }
    const reason = this.classifier.classify(text);
    if (reason && b.machine.state !== 'DISCONNECTED' && b.machine.state !== 'CONNECTING') this.recover(b, reason);
  }
  private join(b: ManagedBot): void {
    if (b.joinAttempts >= this.config.joinMaxAttempts) {
      b.paused = true; this.log(b, 'join attempt budget exhausted; inspect and restart after diagnosis'); return;
    }
    b.joinAttempts++; b.pendingInstance = undefined; b.joinSpawnObserved = false;
    b.generation.invalidate(); b.machine.transition('JOINING_PIT');
    b.deadline = this.now() + this.config.joinTimeoutMs;
    try { b.transport?.chat('/play pit'); } catch { this.disconnected(b); }
  }
  private recover(b: ManagedBot, reason: ReturnReason): void {
    this.cancelExecution(b, false); b.generation.invalidate();
    this.registry.leave(b.id, this.now(), reason);
    b.instanceId = undefined; b.pendingInstance = undefined; b.joinSpawnObserved = false; b.stableSince = undefined;
    b.machine.transition('RECOVERING');
    b.dueAt = this.now() + backoff(Math.max(0, b.joinAttempts - 1), { baseMs: this.config.playCooldownMs, maxMs: Math.max(this.config.playCooldownMs, this.config.reconnect.maxMs), jitter: 0 });
    this.log(b, 'membership lost; recovering', { reason });
  }
  /** Extension point for a verified lobby detector or a local operator. No AFK inference. */
  notifyLobbyReturn(botId: string, reason: ReturnReason = 'UNKNOWN_RETURN'): void {
    const b = this.bots.find(b => b.id === botId);
    if (!b || ['CONNECTING', 'DISCONNECTED'].includes(b.machine.state)) return;
    this.recover(b, reason); b.ready = true;
  }
  private disconnected(b: ManagedBot): void {
    if (b.machine.state === 'DISCONNECTED') return;
    this.cancelExecution(b, false); b.generation.invalidate(); b.connection++;
    this.registry.leave(b.id, this.now(), this.stopped ? 'PLANNED' : 'DISCONNECT');
    b.instanceId = undefined; b.pendingInstance = undefined; b.joinSpawnObserved = false; b.stableSince = undefined; b.ready = false;
    const transport = b.transport; b.transport = undefined;
    b.machine.transition('DISCONNECTED');
    b.dueAt = this.now() + backoff(b.reconnectAttempts++, this.config.reconnect, this.random);
    try { transport?.close(); } catch { this.log(b, 'transport close failed'); }
  }
  private cancelExecution(b: ManagedBot, idle: boolean): void {
    const execution = b.execution;
    b.execution = undefined; execution?.abort.abort();
    try { b.transport?.stopPath(); } catch { this.log(b, 'path stop failed'); }
    if (execution) this.scheduler.release(execution.id, b.id, execution.lease, this.now());
    if (idle && ['PATHFINDING', 'WORKING'].includes(b.machine.state)) b.machine.transition('IN_PIT_IDLE');
  }
  private execute(b: ManagedBot, id: string, lease: number, event: GameEvent): void {
    const execution: Execution = { id, lease, generation: b.generation.current, abort: new AbortController() };
    b.execution = execution; b.machine.transition('PATHFINDING');
    const transport = b.transport!;
    const current = () => b.execution === execution && !execution.abort.signal.aborted &&
      b.generation.isCurrent(execution.generation) && b.instanceId === event.instanceId && this.scheduler.owns(id, b.id, lease);
    void (async () => {
      try {
        await this.paths.submit(`${b.id}:${id}:${lease}`, execution.abort.signal,
          signal => transport.navigate(event.target, signal), () => transport.stopPath());
        if (!current()) return;
        if (event.expiresAt <= this.now()) throw new Error('Expired');
        this.scheduler.running(id, b.id, lease, this.now()); b.machine.transition('WORKING');
        const timer = setTimeout(() => execution.abort.abort(), this.config.taskTimeoutMs);
        let taskAbort: (() => void) | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error('Task aborted'));
            taskAbort = abort;
            execution.abort.signal.addEventListener('abort', abort, { once: true });
            Promise.resolve().then(() => { execution.abort.signal.throwIfAborted(); return this.task.onArrive(this.view(b), event, execution.abort.signal); })
              .then(resolve, reject).finally(() => execution.abort.signal.removeEventListener('abort', abort));
          });
        } finally { clearTimeout(timer); if (taskAbort) execution.abort.signal.removeEventListener('abort', taskAbort); }
        if (current()) { this.scheduler.complete(id, b.id, lease, this.now()); this.log(b, 'job completed', { eventId: event.id }); }
      } catch {
        if (b.execution === execution) { this.scheduler.release(id, b.id, lease, this.now()); this.log(b, 'job returned or failed', { eventId: event.id }); }
      } finally {
        if (b.execution === execution && b.generation.isCurrent(execution.generation)) {
          b.execution = undefined;
          if (['PATHFINDING', 'WORKING'].includes(b.machine.state)) b.machine.transition('IN_PIT_IDLE');
        }
      }
    })();
  }
  stop(): void {
    if (this.stopped) return; this.stopped = true;
    for (const bot of this.bots) this.disconnected(bot);
    this.paths.cancelAll();
  }
}

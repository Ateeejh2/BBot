import { StateMachine, Generation } from '../core/state.js';
import { UnknownReturnClassifier, type BotView, type GameEvent, type JobFailureReason, type ReturnClassifier, type ReturnReason } from '../core/types.js';
import type { Config } from '../config/index.js';
import { Logger, safeKickReason } from '../logging/logger.js';
import { parseInstance } from '../instances/parser.js';
import { InstanceRegistry } from '../instances/registry.js';
import { DistributionManager } from '../instances/distribution.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { PathfindingController, PathfindingError } from '../pathfinding/controller.js';
import { backoff } from '../recovery/backoff.js';
import type { TaskHandler } from '../events/task.js';
import { CarePackageCoordinator } from '../events/care-package.js';
import type { BotTransport, TransportFactory } from './transport.js';
interface Execution { id: string; lease: number; generation: number; abort: AbortController }
interface EventPreparation { timestamp:number; generation:number; abort:AbortController; launched?:boolean; chestEvent?:GameEvent }
interface DebugWalk { generation:number; abort:AbortController }
interface ManagedBot {
  id: string; accountLabel: string; accountId?: string; minecraftName?: string; machine: StateMachine; generation: Generation;
  connection: number; transport?: BotTransport; instanceId?: string; pendingInstance?: string;
  ready: boolean; dueAt: number; deadline: number; reconnectAttempts: number; joinAttempts: number; joinSpawnObserved: boolean;
  stableSince?: number; paused: boolean; authCheckPending?: boolean; execution?: Execution; lastKickReason?: string; lastKickedAt?: number;
  pathAttempts: number; pathCompleted: number; pathFailed: number; pathStartedAt?: number; lastPathMs?: number; lastPathQueueMs?: number;
  preparation?: EventPreparation; debugWalk?: DebugWalk; debugWalkDone: boolean; debugSpawnAt?: number; lastPositionCorrectionAt?: number;
}
export class BotManager {
  private bots: ManagedBot[];
  private stopped = false;
  private configurationLocked = false;
  private nextConnectAt = 0;
  private nextRerollAt = 0;
  private movementDebug = false;
  private sessionFailureHandler?: (botId: string, accountId: string) => Promise<boolean>;
  readonly distribution: DistributionManager;
  constructor(readonly config: Config, private factory: TransportFactory,
    readonly registry: InstanceRegistry, readonly scheduler: Scheduler,
    readonly paths: PathfindingController, private task: TaskHandler, private logger: Logger,
    private now = Date.now, private random = Math.random,
    private classifier: ReturnClassifier = new UnknownReturnClassifier(),
    private carePackages?: CarePackageCoordinator) {
    this.distribution = new DistributionManager(config.rerollMaxAttempts, config.rerollCooldownMs);
    this.bots = config.accounts.map((a, i) => {
      const bot: ManagedBot = { id: `bot-${i + 1}`, accountLabel: a.label,
        machine: new StateMachine((_from, to) => this.log(bot, 'state changed', { state: to })),
        generation: new Generation(), connection: 0, ready: false, dueAt: 0, deadline: 0,
        reconnectAttempts: 0, joinAttempts: 0, joinSpawnObserved: false, paused: config.api.enabled,
        pathAttempts: 0, pathCompleted: 0, pathFailed: 0, debugWalkDone: false };
      return bot;
    });
  }
  views(): BotView[] { return this.bots.map(b => this.view(b)); }
  movementDebugEnabled(): boolean { return this.movementDebug; }
  setMovementDebug(enabled: boolean): void {
    if (this.movementDebug === enabled) return;
    this.movementDebug = enabled;
    for (const b of this.bots) b.debugWalkDone = false;
  }
  carePackageTrackingSnapshot() {
    return this.carePackages?.trackingSnapshot(this.now());
  }
  performanceSnapshot() {
    const now = this.now();
    return {
      active: this.paths.active,
      queued: this.paths.queued,
      concurrency: this.paths.concurrency,
      bots: this.bots.map(b => ({
        botId: b.id,
        pingMs: b.transport?.ping?.(),
        pathAttempts: b.pathAttempts,
        pathCompleted: b.pathCompleted,
        pathFailed: b.pathFailed,
        activePathMs: b.pathStartedAt === undefined ? undefined : Math.max(0, now - b.pathStartedAt),
        lastPathMs: b.lastPathMs,
        lastPathQueueMs: b.lastPathQueueMs
      }))
    };
  }
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
    if (this.movementDebug || b.machine.state !== 'LOBBY' || !b.ready) throw new Error('INVALID_STATE');
    this.join(b);
  }
  testLaunchPad(id: string): { target: { x:number; z:number } } {
    const b = this.controlled(id);
    if (this.movementDebug || b.machine.state !== 'IN_PIT_IDLE' || !b.instanceId || b.execution || b.preparation) throw new Error('INVALID_STATE');
    const transport = b.transport;
    if (!transport?.launchToward) throw new Error('UNSUPPORTED_ACTION');
    const position = transport.position();
    if (!position) throw new Error('INVALID_STATE');
    const radius = Math.hypot(position.x, position.z);
    const outwardX = radius >= 1 ? position.x / radius : 1;
    const outwardZ = radius >= 1 ? position.z / radius : 0;
    const target = { x: position.x + outwardX * 128, z: position.z + outwardZ * 128 };
    const preparation: EventPreparation = { timestamp: this.now(), generation: b.generation.current, abort: new AbortController() };
    b.preparation = preparation;
    b.machine.transition('PREPARING_EVENT');
    this.log(b, 'launch pad test started', { targetX: target.x, targetZ: target.z });
    void transport.launchToward(target, preparation.abort.signal).then(() => {
      if (b.preparation !== preparation || !b.generation.isCurrent(preparation.generation)) return;
      this.log(b, 'launch pad test completed');
    }, error => {
      if (b.preparation !== preparation || !b.generation.isCurrent(preparation.generation)) return;
      this.log(b, 'launch pad test failed', { reason:this.movementFailure(error) });
    }).finally(() => {
      if (b.preparation !== preparation || !b.generation.isCurrent(preparation.generation)) return;
      b.preparation = undefined;
      if (b.machine.state === 'PREPARING_EVENT') b.machine.transition('IN_PIT_IDLE');
    });
    return { target };
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
  private view(b: ManagedBot): BotView { return { id: b.id, accountId: b.accountId, accountLabel: b.accountLabel, minecraftName: b.minecraftName, state: b.machine.state, instanceId: b.instanceId, generation: b.generation.current, position: b.transport?.position(), startQueued: b.machine.state === 'DISCONNECTED' && !b.paused, jobId: b.execution?.id, kickReason: b.lastKickReason, kickedAt: b.lastKickedAt }; }
  private log(b: ManagedBot, message: string, extra: Record<string, unknown> = {}): void {
    this.logger.log('info', message, { botId: b.id, accountLabel: b.accountLabel, instance: b.instanceId, state: b.machine.state, jobId: b.execution?.id, ...extra });
  }
  private movementFailure(error:unknown):string {
    const message=error instanceof Error?error.message:'';
    const allowed=new Set(['No path to the goal!','Path planning timeout','Control walk timeout','Position unavailable','Control walk stuck',
      'Control walk ended before arrival','Control turn timeout','Launch pad not found','Launch pad unavailable','Launch cancelled',
      'Launch landing timeout','Launch pad did not trigger','Landing wait timeout']);
    return allowed.has(message)?message:'Movement failed';
  }
  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    if (!this.movementDebug) for (const expired of this.scheduler.expire(now)) {
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
      if (this.movementDebug && b.machine.state === 'LOBBY' && b.ready && !b.debugWalkDone) {
        const quietSince = Math.max(b.debugSpawnAt ?? now, b.lastPositionCorrectionAt ?? Number.NEGATIVE_INFINITY);
        if (now - quietSince >= 1500) this.startDebugWalk(b);
      }
      if (!this.movementDebug && ['LOBBY', 'RECOVERING'].includes(b.machine.state) && b.ready && now >= b.dueAt) this.join(b);
      if (b.instanceId) this.registry.heartbeat(b.instanceId, now);
      if (b.stableSince !== undefined && now - b.stableSince >= 60000) { b.reconnectAttempts = 0; b.joinAttempts = 0; }
    }
    if (this.movementDebug) return;
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
        chickenSpawn: position => {
          if (this.stopped || this.movementDebug || b.connection !== connection || !b.instanceId || !this.carePackages) return;
          const detection=this.carePackages.observeChicken(b.instanceId,position,this.now());
          if(detection)this.prepareCarePackage(b,detection.timestamp,detection.target);
        },
        chestAppeared: position => {
          if (this.stopped || this.movementDebug || b.connection !== connection || !b.instanceId || !this.carePackages) return;
          const event=this.carePackages.observeChest(b.instanceId,position,this.now());
          if(!event)return;
          const scheduledAt=typeof event.metadata?.scheduledAt==='number'?event.metadata.scheduledAt:undefined;
          const reserved=this.bots.find(bot=>bot.instanceId===event.instanceId&&bot.preparation&&bot.preparation.timestamp===scheduledAt);
          if(reserved?.preparation){
            reserved.preparation.chestEvent=event;
            this.log(b,'care package chest detected',{eventId:event.id,x:position.x,y:position.y,z:position.z,reservedBotId:reserved.id});
            this.continuePreparedCarePackage(reserved,reserved.preparation);
            return;
          }
          const accepted=this.scheduler.enqueue(event,this.now());
          this.log(b,'care package chest detected',{eventId:event.id,x:position.x,y:position.y,z:position.z,accepted});
        },
        diagnostic: (name, fields) => {
          if (this.stopped || b.connection !== connection) return;
          if (name === 'server position correction') b.lastPositionCorrectionAt = this.now();
          const level = name.startsWith('viewer ') || name === 'server position correction' || name === 'movement packet after correction' ? 'info' : 'debug';
          this.logger.log(level, name, { botId: b.id, accountLabel: b.accountLabel,
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
    if (this.movementDebug) {
      if (b.machine.state === 'CONNECTING') b.machine.transition('LOBBY');
      else if (b.machine.state === 'PATHFINDING') this.cancelDebugWalk(b, true);
      else if (b.machine.state !== 'LOBBY') return;
      b.debugWalkDone = false;
      b.debugSpawnAt = this.now();
      this.log(b,'movement debug waiting for position settle',{quietMs:1500});
      return;
    }
    if (b.machine.state === 'CONNECTING') {
      b.machine.transition('LOBBY'); b.dueAt = this.now() + this.config.playCooldownMs;
    } else if (b.machine.state === 'JOINING_PIT') {
      // 1.8.9/Bungee event order is not assumed: require both an exact transfer notice and a spawn
      // from the same join attempt, but accept either observation order.
      b.joinSpawnObserved = true;
      this.confirmJoinedInstance(b);
    } else if (b.machine.state !== 'RECOVERING' && b.machine.state !== 'LOBBY' && b.machine.state !== 'PREPARING_EVENT') {
      this.recover(b, 'UNKNOWN_RETURN');
    }
  }
  private worldReset(b: ManagedBot): void {
    b.ready = false;
    if (this.movementDebug) { this.cancelDebugWalk(b, true); b.debugWalkDone = false; b.debugSpawnAt = undefined; return; }
    if (b.machine.state === 'JOINING_PIT' || b.machine.state === 'CONNECTING') return;
    this.recover(b, 'UNKNOWN_RETURN'); b.deadline = this.now() + this.config.joinTimeoutMs;
  }
  private message(b: ManagedBot, text: string): void {
    if (this.movementDebug) return;
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
    this.cancelDebugWalk(b, true); this.cancelPreparation(b); this.cancelExecution(b, false); b.generation.invalidate();
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
    this.cancelDebugWalk(b, true); this.cancelPreparation(b); this.cancelExecution(b, false); b.generation.invalidate(); b.connection++;
    this.registry.leave(b.id, this.now(), this.stopped ? 'PLANNED' : 'DISCONNECT');
    b.instanceId = undefined; b.pendingInstance = undefined; b.joinSpawnObserved = false; b.stableSince = undefined; b.ready = false; b.debugWalkDone = false;
    const transport = b.transport; b.transport = undefined;
    b.debugSpawnAt = undefined; b.lastPositionCorrectionAt = undefined;
    b.machine.transition('DISCONNECTED');
    b.dueAt = this.now() + backoff(b.reconnectAttempts++, this.config.reconnect, this.random);
    try { transport?.close(); } catch { this.log(b, 'transport close failed'); }
  }
  private prepareCarePackage(source:ManagedBot,timestamp:number,target:{x:number;y:number;z:number}):void {
    if(this.movementDebug||!source.instanceId||!this.carePackages)return;
    const candidates=this.bots.filter(bot=>bot.instanceId===source.instanceId&&bot.machine.state==='IN_PIT_IDLE'&&!bot.execution&&!bot.preparation&&bot.transport?.launchToward);
    const bot=candidates.find(value=>value.id===source.id)??candidates[0];
    if(!bot)return;
    const transport=bot.transport!;
    const preparation:EventPreparation={timestamp,generation:bot.generation.current,abort:new AbortController()};
    bot.preparation=preparation; bot.machine.transition('PREPARING_EVENT');
    this.carePackages.markLaunch(bot.instanceId!,timestamp,'LAUNCHING');
    this.log(bot,'care package launch started',{scheduledAt:timestamp,targetX:target.x,targetZ:target.z});
    void transport.launchToward!({x:target.x,z:target.z},preparation.abort.signal,'LAUNCH').then(()=>{
      if(bot.preparation!==preparation||!bot.generation.isCurrent(preparation.generation)||!bot.instanceId)return;
      preparation.launched=true;
      this.carePackages?.markLaunch(bot.instanceId,timestamp,'DROPPED');
      this.log(bot,'care package launch completed',{scheduledAt:timestamp,completion:'LAUNCH'});
      if(!preparation.chestEvent)this.log(bot,'care package waiting for chest',{scheduledAt:timestamp});
      this.continuePreparedCarePackage(bot,preparation);
    },()=>{
      if(bot.preparation!==preparation||!bot.generation.isCurrent(preparation.generation)||!bot.instanceId)return;
      this.carePackages?.markLaunch(bot.instanceId,timestamp,'LAUNCH_FAILED');
      this.log(bot,'care package launch failed',{scheduledAt:timestamp});
      const fallback=preparation.chestEvent;
      bot.preparation=undefined;
      if(bot.machine.state==='PREPARING_EVENT')bot.machine.transition('IN_PIT_IDLE');
      if(fallback)this.scheduler.enqueue(fallback,this.now());
    });
  }
  private continuePreparedCarePackage(bot:ManagedBot,preparation:EventPreparation):void {
    const event=preparation.chestEvent;
    if(!preparation.launched||!event||bot.preparation!==preparation||!bot.generation.isCurrent(preparation.generation)||bot.instanceId!==event.instanceId)return;
    bot.preparation=undefined;
    if(bot.machine.state==='PREPARING_EVENT')bot.machine.transition('IN_PIT_IDLE');
    const now=this.now();
    const accepted=this.scheduler.enqueue(event,now);
    if(!accepted){
      this.log(bot,'care package chest handoff failed',{eventId:event.id,reason:'ENQUEUE_REJECTED'});
      return;
    }
    const assignment=this.scheduler.assignTo(event.id,this.view(bot),now);
    if(!assignment){
      this.log(bot,'care package chest handoff failed',{eventId:event.id,reason:'RESERVATION_FAILED'});
      return;
    }
    this.log(bot,'care package chest path started',{eventId:event.id,targetX:event.target.x,targetY:event.target.y,targetZ:event.target.z});
    this.execute(bot,assignment.job.id,assignment.job.lease,assignment.job.event);
  }
  private cancelDebugWalk(b:ManagedBot,idle:boolean):void {
    const debug=b.debugWalk;
    if(!debug)return;
    b.debugWalk=undefined;
    debug.abort.abort();
    try{b.transport?.stopPath();}catch{this.log(b,'path stop failed');}
    if(idle&&b.machine.state==='PATHFINDING')b.machine.transition('LOBBY');
  }
  private startDebugWalk(b:ManagedBot):void {
    if(!this.movementDebug||b.debugWalk||b.debugWalkDone||b.machine.state!=='LOBBY'||!b.ready||!b.transport)return;
    const start=b.transport.position();
    if(!start)return;
    const debug:DebugWalk={generation:b.generation.current,abort:new AbortController()};
    b.debugWalk=debug;b.debugWalkDone=true;b.machine.transition('PATHFINDING');
    const transport=b.transport;
    const directions=[{x:6,z:0},{x:0,z:6},{x:-6,z:0},{x:0,z:-6}];
    this.log(b,'movement debug path started',{startX:start.x,startY:start.y,startZ:start.z});
    void(async()=>{
      let directionIndex=0;
      try{
        while(this.movementDebug&&b.debugWalk===debug&&!debug.abort.signal.aborted&&b.generation.isCurrent(debug.generation)){
          const position=transport.position();
          if(!position)throw new Error('Position unavailable');
          let moved=false;
          let lastError:unknown;
          for(let offset=0;offset<directions.length;offset++){
            if(b.debugWalk!==debug||debug.abort.signal.aborted||!b.generation.isCurrent(debug.generation))return;
            const selected=(directionIndex+offset)%directions.length;
            const direction=directions[selected]!;
            const target={x:position.x+direction.x,y:position.y,z:position.z+direction.z};
            try{
              b.pathAttempts++;
              const queuedAt=this.now();
              await this.paths.submit(`debug:${b.id}:${debug.generation}:${b.pathAttempts}`,debug.abort.signal,async signal=>{
                const startedAt=this.now();b.pathStartedAt=startedAt;b.lastPathQueueMs=Math.max(0,startedAt-queuedAt);
                try{await transport.navigate(target,signal);b.pathCompleted++;}
                catch(error){b.pathFailed++;throw error;}
                finally{if(b.pathStartedAt===startedAt){b.lastPathMs=Math.max(0,this.now()-startedAt);b.pathStartedAt=undefined;}}
              },()=>transport.stopPath());
              if(b.debugWalk!==debug||debug.abort.signal.aborted||!b.generation.isCurrent(debug.generation))return;
              directionIndex=(selected+1)%directions.length;
              moved=true;
              this.log(b,'movement debug path completed',{targetX:target.x,targetY:target.y,targetZ:target.z});
              break;
            }catch(error){
              lastError=error;
              if(debug.abort.signal.aborted)return;
            }
          }
          if(moved)continue;
          if(b.debugWalk===debug&&b.generation.isCurrent(debug.generation))
            this.log(b,'movement debug path failed',{reason:lastError instanceof PathfindingError?lastError.code:this.movementFailure(lastError)});
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }catch(error){
        if(!debug.abort.signal.aborted&&b.debugWalk===debug&&b.generation.isCurrent(debug.generation))
          this.log(b,'movement debug path failed',{reason:error instanceof PathfindingError?error.code:this.movementFailure(error)});
      }finally{
        if(b.debugWalk===debug&&b.generation.isCurrent(debug.generation)){
          b.debugWalk=undefined;
          if(b.machine.state==='PATHFINDING')b.machine.transition('LOBBY');
        }
      }
    })();
  }
  private cancelPreparation(b:ManagedBot):void {
    const preparation=b.preparation;b.preparation=undefined;preparation?.abort.abort();
    if(b.machine.state==='PREPARING_EVENT')b.machine.transition('IN_PIT_IDLE');
  }
  private cancelExecution(b: ManagedBot, idle: boolean, reason: JobFailureReason = 'INSTANCE_LOST'): void {
    const execution = b.execution;
    b.execution = undefined; execution?.abort.abort();
    try { b.transport?.stopPath(); } catch { this.log(b, 'path stop failed'); }
    if (execution) this.scheduler.release(execution.id, b.id, execution.lease, this.now(), reason);
    if (idle && ['PATHFINDING', 'WORKING'].includes(b.machine.state)) b.machine.transition('IN_PIT_IDLE');
  }
  private execute(b: ManagedBot, id: string, lease: number, event: GameEvent): void {
    const execution: Execution = { id, lease, generation: b.generation.current, abort: new AbortController() };
    b.execution = execution; b.machine.transition('PATHFINDING');
    const transport = b.transport!;
    const queuedAt = this.now();
    b.pathAttempts++;
    const current = () => b.execution === execution && !execution.abort.signal.aborted &&
      b.generation.isCurrent(execution.generation) && b.instanceId === event.instanceId && this.scheduler.owns(id, b.id, lease);
    void (async () => {
      let pathRan = false;
      let stage: 'PATH' | 'TASK' = 'PATH';
      let taskTimedOut = false;
      try {
        await this.paths.submit(`${b.id}:${id}:${lease}`, execution.abort.signal,
          async signal => {
            pathRan = true;
            const startedAt = this.now();
            b.pathStartedAt = startedAt;
            b.lastPathQueueMs = Math.max(0, startedAt - queuedAt);
            try {
              await transport.navigate(event.target, signal);
              b.pathCompleted++;
            } catch (error) {
              b.pathFailed++;
              throw error;
            } finally {
              if (b.pathStartedAt === startedAt) {
                b.lastPathMs = Math.max(0, this.now() - startedAt);
                b.pathStartedAt = undefined;
              }
            }
          }, () => transport.stopPath());
        if (!current()) return;
        if (event.expiresAt <= this.now()) throw new Error('JOB_EXPIRED');
        stage = 'TASK';
        this.scheduler.running(id, b.id, lease, this.now()); b.machine.transition('WORKING');
        const timer = setTimeout(() => { taskTimedOut = true; execution.abort.abort(); }, this.config.taskTimeoutMs);
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
      } catch (error) {
        if (!pathRan) b.pathFailed++;
        if (b.execution === execution) {
          const reason: JobFailureReason = error instanceof Error && error.message === 'JOB_EXPIRED' ? 'JOB_EXPIRED' :
            stage === 'PATH' && error instanceof PathfindingError ? error.code :
            stage === 'TASK' ? (taskTimedOut ? 'TASK_TIMEOUT' : 'TASK_FAILED') : 'PATH_FAILED';
          this.scheduler.release(id, b.id, lease, this.now(), reason);
          const job = this.scheduler.jobs.get(id);
          this.log(b, 'job returned or failed', { eventId: event.id, failureReason: reason, attempt: job?.attempts, jobState: job?.state });
        }
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
    for (const bot of this.bots) { this.cancelDebugWalk(bot, true); this.cancelPreparation(bot); this.disconnected(bot); }
    this.paths.cancelAll();
  }
}

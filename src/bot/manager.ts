import { StateMachine, Generation } from '../core/state.js';
import { UnknownReturnClassifier, type BotView, type GameEvent, type JobFailureReason, type ModerationIncident, type Position, type ReturnClassifier, type ReturnReason } from '../core/types.js';
import type { Config } from '../config/index.js';
import { Logger, safeKickReason } from '../logging/logger.js';
import { classifyDisconnectReason } from '../runtime/kick-ban.js';
import { parseInstance, parseLocrawPitInstance } from '../instances/parser.js';
import { InstanceRegistry } from '../instances/registry.js';
import { DistributionManager } from '../instances/distribution.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { PathfindingController, PathfindingError } from '../pathfinding/controller.js';
import { backoff } from '../recovery/backoff.js';
import type { TaskHandler } from '../events/task.js';
import { CarePackageCoordinator } from '../events/care-package.js';
import type { BotTransport, TransportFactory } from './transport.js';
import { isDeathNotice, isLimboNotice } from './message-source.js';
interface Execution { id: string; lease: number; generation: number; abort: AbortController; event: GameEvent }
interface EventPreparation {
  timestamp:number; generation:number; abort:AbortController; expiresAt?:number; launched?:boolean; chestEvent?:GameEvent;
  predictionAbort?:AbortController; predictionTarget?:Position;
}
interface DebugWalk { generation:number; abort:AbortController }
interface LimboRecovery { playAt:number; phase:'WAIT_LOBBY'|'JOINING_PIT'; source:'LIMBO'|'LOW_POPULATION'|'DISTRIBUTION' }
interface CarePackageRun { timestamp:number; instanceId:string; target:Position; expiresAt:number; chestEvent?:GameEvent }
interface ManagedBot {
  id: string; accountLabel: string; accountId?: string; minecraftName?: string; machine: StateMachine; generation: Generation;
  connection: number; transport?: BotTransport; instanceId?: string; pendingInstance?: string;
  pendingServer?: { host: string; port: number };
  ready: boolean; dueAt: number; deadline: number; reconnectAttempts: number; joinAttempts: number; joinSpawnObserved: boolean;
  transferLocrawAt?: number;
  stableSince?: number; paused: boolean; authCheckPending?: boolean; execution?: Execution; lastKickReason?: string; lastKickedAt?: number; moderation?: ModerationIncident;
  pathAttempts: number; pathCompleted: number; pathFailed: number; pathStartedAt?: number; lastPathMs?: number; lastPathQueueMs?: number;
  preparation?: EventPreparation; debugWalk?: DebugWalk; limboRecovery?: LimboRecovery; carePackage?:CarePackageRun; careRetryAt?:number;
  activity?: { kind:'SCANNING_CHUNKS'; progress:number };
  pitPopulation?: number; pitPopulationCheckInstance?: string; nextPitPopulationCheckAt: number;
  debugWalkDone: boolean; debugSpawnAt?: number; lastPositionCorrectionAt?: number; lastHorizontalCollisionAt?: number;
}
export class BotManager {
  private bots: ManagedBot[];
  private stopped = false;
  private configurationLocked = false;
  private nextConnectAt = 0;
  private nextRerollAt = 0;
  private movementDebug = false;
  private chatDebugSequence = 0;
  private chatDebugEntries: Array<{ id:number; at:number; botId:string; instanceId?:string; channel:string; text:string }> = [];
  private sessionFailureHandler?: (botId: string, accountId: string) => Promise<boolean>;
  private banDetectedHandler?: (botId: string, accountId: string, reason: string, detectedAt: number) => Promise<void> | void;
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
        pathAttempts: 0, pathCompleted: 0, pathFailed: 0, nextPitPopulationCheckAt: 0, debugWalkDone: false };
      return bot;
    });
  }
  views(): BotView[] { return this.bots.map(b => this.view(b)); }
  movementDebugEnabled(): boolean { return this.movementDebug; }
  chatDebugSnapshot() { return this.chatDebugEntries.map(entry => ({ ...entry })); }
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
  setBanDetectedHandler(handler: (botId: string, accountId: string, reason: string, detectedAt: number) => Promise<void> | void): void {
    this.banDetectedHandler = handler;
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
    if (this.config.mode === 'live' && this.config.api.enabled && this.config.transport !== 'forge' && !b.accountId) throw new Error('ACCOUNT_REQUIRED');
    b.paused = false; b.dueAt = 0;
    const now = this.now();
    if (now >= this.nextConnectAt) {
      this.nextConnectAt = now + this.config.connectionSpacingMs;
      this.connect(b, this.bots.indexOf(b));
    }
  }

  startServer(id: string, host: string, port: number): void {
    if (this.config.transport !== 'forge') throw new Error('UNSUPPORTED_ACTION');
    if (!/^[a-z\d.:_-]+$/i.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_INPUT');
    const b = this.controlled(id);
    if (b.machine.state !== 'DISCONNECTED' || !b.paused || b.authCheckPending || b.pendingServer) throw new Error('INVALID_STATE');

    // Reuse the existing Forge bridge after an explicit server Disconnect.
    // The Forge worker/client lifecycle is independent from the Minecraft server session.
    if (b.transport?.connectServer) {
      b.paused = false; b.ready = false; b.dueAt = 0;
      b.machine.transition('CONNECTING');
      b.deadline = this.now() + this.config.connectTimeoutMs;
      const connection = b.connection;
      void b.transport.connectServer(host, port).catch(() => {
        if (this.stopped || b.connection !== connection) return;
        b.paused = true;
        this.log(b, 'server connect failed');
        this.serverDisconnected(b);
      });
      return;
    }

    b.pendingServer = { host, port };
    try { this.connectBot(id); }
    catch (error) { b.pendingServer = undefined; throw error; }
  }

  async disconnectServer(id: string): Promise<void> {
    if (this.config.transport !== 'forge') throw new Error('UNSUPPORTED_ACTION');
    const b = this.controlled(id);
    if (b.machine.state === 'DISCONNECTED' || !b.transport?.disconnectServer) throw new Error('INVALID_STATE');
    const wasPaused = b.paused;
    b.paused = true;
    try {
      await b.transport.disconnectServer();
      if (this.view(b).state !== 'DISCONNECTED') this.serverDisconnected(b);
    } catch (error) {
      b.paused = wasPaused;
      throw error;
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
  oofBot(id: string): void {
    const b = this.controlled(id);
    if (!b.transport || ['DISCONNECTED','CONNECTING'].includes(b.machine.state)) throw new Error('INVALID_STATE');
    b.transport.chat('/oof');
    this.log(b, 'oof command sent');
  }
  testCarePackage(id:string):{ launchTarget:{x:number;z:number} } {
    const b=this.controlled(id);
    if(this.movementDebug||b.machine.state!=='IN_PIT_IDLE'||!b.instanceId||b.execution||b.preparation)throw new Error('INVALID_STATE');
    const transport=b.transport;
    if(!transport?.launchToward)throw new Error('UNSUPPORTED_ACTION');
    const position=transport.position();
    if(!position)throw new Error('INVALID_STATE');
    const radius=Math.hypot(position.x,position.z);
    const outwardX=radius>=1?position.x/radius:1;
    const outwardZ=radius>=1?position.z/radius:0;
    const launchTarget={x:position.x+outwardX*128,z:position.z+outwardZ*128};
    const preparation:EventPreparation={timestamp:this.now(),generation:b.generation.current,abort:new AbortController(),expiresAt:this.now()+60_000};
    b.preparation=preparation;b.machine.transition('PREPARING_EVENT');
    this.log(b,'care package test started',{targetX:launchTarget.x,targetZ:launchTarget.z});
    void(async()=>{
      try{
        await transport.launchToward!(launchTarget,preparation.abort.signal,'LANDING');
        if(b.preparation!==preparation||!b.generation.isCurrent(preparation.generation)||!b.instanceId)return;
        const landing=transport.position();
        if(!landing)throw new Error('Position unavailable');
        const chestTarget={x:landing.x+outwardX*4,y:landing.y,z:landing.z+outwardZ*4};
        const event:GameEvent={
          id:`care-package-test:${b.id}:${preparation.timestamp}:${preparation.generation}`,
          instanceId:b.instanceId,
          type:'care-package-test',
          target:chestTarget,
          expiresAt:this.now()+60_000,
          metadata:{source:'manual-test'}
        };
        b.preparation=undefined;
        if(b.machine.state==='PREPARING_EVENT')b.machine.transition('IN_PIT_IDLE');
        if(!this.scheduler.enqueue(event,this.now()))throw new Error('JOB_REJECTED');
        const assignment=this.scheduler.assignTo(event.id,this.view(b),this.now());
        if(!assignment){this.scheduler.jobs.delete(event.id);throw new Error('RESERVATION_FAILED');}
        this.log(b,'care package test chest generated',{eventId:event.id,x:chestTarget.x,y:chestTarget.y,z:chestTarget.z});
        this.log(b,'care package test chest path started',{eventId:event.id});
        this.execute(b,assignment.job.id,assignment.job.lease,assignment.job.event);
      }catch(error){
        if(b.preparation===preparation&&b.generation.isCurrent(preparation.generation))
          this.log(b,'care package test failed',{reason:this.movementFailure(error)});
      }finally{
        if(b.preparation===preparation&&b.generation.isCurrent(preparation.generation)){
          b.preparation=undefined;
          if(b.machine.state==='PREPARING_EVENT')b.machine.transition('IN_PIT_IDLE');
        }
      }
    })();
    return {launchTarget};
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
  assignAccount(botId: string, accountId: string, account: Config['accounts'][number], minecraftName?: string,
    ban?: { reason: string; detectedAt: number }): void {
    const b = this.controlled(botId);
    if (b.machine.state !== 'DISCONNECTED' || !b.paused || b.authCheckPending) throw new Error('INVALID_STATE');
    this.config.accounts[this.bots.indexOf(b)] = account;
    b.accountId = accountId; b.accountLabel = account.label; b.minecraftName = minecraftName; b.authCheckPending = false;
    b.moderation = ban ? { kind:'BAN', reason:ban.reason, detectedAt:ban.detectedAt, persistent:true } : undefined;
    b.lastKickReason = ban?.reason; b.lastKickedAt = ban?.detectedAt;
  }
  unassignAccount(botId: string): void {
    const b = this.controlled(botId);
    if (b.machine.state !== 'DISCONNECTED' || !b.paused || b.authCheckPending) throw new Error('INVALID_STATE');
    b.accountId = undefined; b.accountLabel = b.id; b.minecraftName = undefined; b.authCheckPending = false;
    b.moderation = undefined; b.lastKickReason = undefined; b.lastKickedAt = undefined;
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
  private view(b: ManagedBot): BotView { return { id: b.id, accountId: b.accountId, accountLabel: b.accountLabel, minecraftName: b.minecraftName, state: b.machine.state, instanceId: b.instanceId, generation: b.generation.current, position: b.transport?.position(), startQueued: b.machine.state === 'DISCONNECTED' && !b.paused, jobId: b.execution?.id, kickReason: b.lastKickReason, kickedAt: b.lastKickedAt, moderation: b.moderation, activity: b.activity }; }
  private log(b: ManagedBot, message: string, extra: Record<string, unknown> = {}): void {
    this.logger.log('info', message, { botId: b.id, accountLabel: b.accountLabel, instance: b.instanceId, state: b.machine.state, jobId: b.execution?.id, ...extra });
  }
  private movementFailure(error:unknown):string {
    const message=error instanceof Error?error.message:'';
    const allowed=new Set(['No path to the goal!','Path planning timeout','Control walk timeout','Position unavailable','Control walk stuck',
      'Control walk ended before arrival','Control turn timeout','Launch pad not found','Launch pad unavailable','Launch cancelled',
      'Launch pad approach timeout','Launch landing timeout','Launch pad did not trigger','Landing wait timeout','Control walk collision','JOB_REJECTED','RESERVATION_FAILED']);
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
      if(b.carePackage&&now>=b.carePackage.expiresAt){
        this.stopCarePackage(b,'EXPIRED');
      }
      if (b.preparation?.expiresAt!==undefined && now>=b.preparation.expiresAt) {
        this.log(b,'care package preparation expired',{scheduledAt:b.preparation.timestamp});
        this.cancelPreparation(b);
      }
      if(b.careRetryAt!==undefined&&now>=b.careRetryAt){
        const run=b.carePackage;
        b.careRetryAt=undefined;
        if(run&&b.machine.state==='IN_PIT_IDLE'&&b.instanceId===run.instanceId&&
          this.carePackages?.isActive(run.instanceId,run.timestamp,now)){
          const target=run.chestEvent?.target??run.target;
          this.log(b,'care package death retry starting',{scheduledAt:run.timestamp,targetX:target.x,targetZ:target.z});
          this.prepareCarePackage(b,run.timestamp,target);
        }
      }
      if (!this.configurationLocked && b.machine.state === 'DISCONNECTED' && now >= b.dueAt && now >= this.nextConnectAt) {
        this.nextConnectAt = now + this.config.connectionSpacingMs; this.connect(b, index); continue;
      }
      if (b.machine.state === 'CONNECTING' && now >= b.deadline) {
        this.log(b,'server connection timed out',{timeoutMs:this.config.connectTimeoutMs});
        this.checkSessionAfterConnectFailure(b);
        if(this.config.transport==='forge')b.paused=true;
        this.disconnected(b);
        continue;
      }
      const limboRecovery=b.limboRecovery;
      if(limboRecovery?.phase==='WAIT_LOBBY'&&b.machine.state==='RECOVERING'){
        if(b.ready&&now>=limboRecovery.playAt){
          this.log(b,'lobby requeue sending Pit command',{source:limboRecovery.source,waitedMs:Math.max(0,now-limboRecovery.playAt)});
          this.join(b);
          if(b.limboRecovery===limboRecovery)limboRecovery.phase='JOINING_PIT';
          continue;
        }
        if(!b.ready&&now>=b.deadline){
          this.log(b,'lobby requeue wait timed out',{source:limboRecovery.source});
          b.limboRecovery=undefined;
          this.disconnected(b);
          continue;
        }
        continue;
      }
      if (b.machine.state === 'JOINING_PIT' && b.transferLocrawAt !== undefined &&
          now >= b.transferLocrawAt && b.pendingInstance && !b.joinSpawnObserved) {
        b.transferLocrawAt = undefined;
        try {
          b.transport?.chat('/locraw');
          this.log(b,'Pit instance fallback requested',{source:'transfer-no-spawn'});
        } catch {
          this.log(b,'Pit instance fallback request failed');
        }
      }
      if (b.machine.state === 'JOINING_PIT' && now >= b.deadline) {
        this.recover(b, 'UNKNOWN_RETURN');
        this.log(b, 'join timed out; no confirmed instance');
      }
      if (b.machine.state === 'RECOVERING' && !b.ready && now >= b.deadline) { this.disconnected(b); continue; }
      if (this.movementDebug && b.machine.state === 'LOBBY' && b.ready && !b.debugWalkDone) {
        const quietSince = Math.max(b.debugSpawnAt ?? now, b.lastPositionCorrectionAt ?? Number.NEGATIVE_INFINITY);
        if (now - quietSince >= 1500) this.startDebugWalk(b);
      }
      if (!this.movementDebug && !b.limboRecovery && ['LOBBY', 'RECOVERING'].includes(b.machine.state) && b.ready && now >= b.dueAt) this.join(b);
      if (b.instanceId && b.machine.state === 'IN_PIT_IDLE' && now >= b.nextPitPopulationCheckAt) this.checkPitPopulation(b);
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
        const sourceInstance=b.instanceId;
        const sourceOccupancy=sourceInstance?this.registry.records.get(sourceInstance)?.bots.size:undefined;
        this.distribution.recordAttempt(b.id, now); this.nextRerollAt = now + this.config.rerollCooldownMs;
        this.log(b,'instance distribution reroll',{
          sourceInstance:sourceInstance??null,
          sourceOccupancy:sourceOccupancy??null
        });
        this.startLobbyRequeue(b,'DISTRIBUTION',0,{
          sourceInstance:sourceInstance??null,
          sourceOccupancy:sourceOccupancy??null
        });
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
    if (b.moderation?.kind !== 'BAN') {
      b.moderation = undefined; b.lastKickReason = undefined; b.lastKickedAt = undefined;
    }
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
          if (this.stopped || this.movementDebug || b.connection !== connection || !b.instanceId || !this.carePackages ||
              !this.pitPopulationAllowsEvents(b)) return;
          const detection=this.carePackages.observeChicken(b.instanceId,position,this.now());
          if(detection)this.prepareCarePackage(b,detection.timestamp,detection.target);
        },
        chestAppeared: position => {
          if (this.stopped || this.movementDebug || b.connection !== connection || !b.instanceId || !this.carePackages ||
              !this.pitPopulationAllowsEvents(b)) return;
          const event=this.carePackages.observeChest(b.instanceId,position,this.now());
          if(!event)return;
          const scheduledAt=typeof event.metadata?.scheduledAt==='number'?event.metadata.scheduledAt:undefined;
          const owner=this.bots.find(bot=>bot.carePackage?.instanceId===event.instanceId&&bot.carePackage.timestamp===scheduledAt);
          if(owner?.carePackage)owner.carePackage.chestEvent=event;
          const reserved=this.bots.find(bot=>bot.instanceId===event.instanceId&&bot.preparation&&bot.preparation.timestamp===scheduledAt);
          if(reserved?.preparation){
            const preparation=reserved.preparation;
            preparation.chestEvent=event;
            this.log(reserved,'care package chest detected',{eventId:event.id,x:position.x,y:position.y,z:position.z,reservedBotId:reserved.id});
            if(preparation.predictionAbort&&!preparation.predictionAbort.signal.aborted){
              this.log(reserved,'care package prediction corrected',{
                eventId:event.id,
                predictedX:preparation.predictionTarget?.x,
                predictedY:preparation.predictionTarget?.y,
                predictedZ:preparation.predictionTarget?.z,
                actualX:position.x,actualY:position.y,actualZ:position.z
              });
              preparation.predictionAbort.abort();
            }else{
              this.continuePreparedCarePackage(reserved,preparation);
            }
            return;
          }
          const accepted=this.scheduler.enqueue(event,this.now());
          this.log(b,'care package chest detected',{eventId:event.id,x:position.x,y:position.y,z:position.z,accepted});
        },
        chestDisappeared: position => {
          if(this.stopped||this.movementDebug||b.connection!==connection||!b.instanceId||!this.carePackages)return;
          const ended=this.carePackages.observeChestDisappeared(b.instanceId,position,this.now());
          if(!ended)return;
          for(const bot of this.bots){
            if(bot.carePackage?.timestamp===ended.timestamp&&bot.carePackage.instanceId===ended.instanceId){
              this.stopCarePackage(bot,'CHEST_DISAPPEARED');
            }
          }
          this.scheduler.jobs.delete(ended.eventId);
          this.log(b,'care package ended; chest disappeared',{eventId:ended.eventId,x:position.x,y:position.y,z:position.z});
        },
        diagnostic: (name, fields) => {
          if (this.stopped || b.connection !== connection) return;
          const now=this.now();
          if(name==='chat message received'){
            const text=typeof fields?.chatText==='string'?fields.chatText.replace(/[\r\n]+/g,' ').trim().slice(0,500):'';
            if(text){
              this.chatDebugEntries.push({
                id:++this.chatDebugSequence,
                at:now,
                botId:b.id,
                instanceId:b.instanceId,
                channel:typeof fields?.channel==='string'?fields.channel.slice(0,32):'unknown',
                text
              });
              if(this.chatDebugEntries.length>200)this.chatDebugEntries.shift();
            }
            return;
          }
          if(name==='pit chunk scan progress'){
            const progress=typeof fields?.progress==='number'&&Number.isFinite(fields.progress)
              ?Math.max(0,Math.min(100,Math.round(fields.progress))):0;
            if(fields?.active===false||progress>=100)b.activity=undefined;
            else b.activity={kind:'SCANNING_CHUNKS',progress};
          } else if(name==='pit path planned'){
            b.activity=undefined;
          }
          let correlated=fields;
          if(name==='control walk collision'){
            b.lastHorizontalCollisionAt=now;
          } else if(name==='server position correction'){
            b.lastPositionCorrectionAt=now;
            correlated={...fields,
              sinceHorizontalCollisionMs:b.lastHorizontalCollisionAt===undefined?null:Math.max(0,now-b.lastHorizontalCollisionAt)};
          }
          const level = name.startsWith('viewer ') || name === 'server position correction' || name === 'movement packet after correction' ||
            name === 'control path planning failed' || name === 'control walk collision' || name === 'launch pad selected' ||
            name === 'pit path planned' || name === 'pit path replan requested' ||
            name === 'pit navigation prewarm started' || name === 'pit navigation prewarm completed' ||
            name === 'pit navigation prewarm failed' || name === 'server disconnect reason' ? 'info' : 'debug';
          this.logger.log(level, name, { botId: b.id, accountLabel: b.accountLabel,
            instance: b.instanceId, state: b.machine.state, ...correlated });
        },
        kicked: (reason, loggedIn) => {
          if (this.stopped || b.connection !== connection) return;
          const kickReason = safeKickReason(reason) ?? 'Unknown kick reason';
          const detectedAt = this.now();
          const kind = classifyDisconnectReason(kickReason);
          b.lastKickReason = kickReason; b.lastKickedAt = detectedAt;
          b.moderation = { kind, reason:kickReason, detectedAt, persistent:kind === 'BAN' };
          this.logger.log('warn', 'bot kicked', { botId: b.id, accountLabel: b.accountLabel,
            instance: b.instanceId, state: b.machine.state, kickReason, moderationKind:kind, loggedIn: loggedIn ?? null });
          if (kind === 'BAN' && b.accountId && this.banDetectedHandler) {
            const accountId = b.accountId;
            try {
              void Promise.resolve(this.banDetectedHandler(b.id, accountId, kickReason, detectedAt))
                .catch(() => this.log(b, 'ban persistence failed'));
            } catch {
              this.log(b, 'ban persistence failed');
            }
          }
          this.checkSessionAfterConnectFailure(b);
          if (this.config.transport === 'forge') b.paused = true;
          this.disconnected(b);
        },
        serverDisconnected: guard(() => {
          this.checkSessionAfterConnectFailure(b);
          if (this.config.transport === 'forge') b.paused = true;
          this.serverDisconnected(b);
        }),
        end: guard(() => {
          this.checkSessionAfterConnectFailure(b);
          if (this.config.transport === 'forge') b.paused = true;
          this.disconnected(b);
        }),
        error: guard(() => {
          this.log(b, 'transport error (details withheld)');
          this.checkSessionAfterConnectFailure(b);
          if (this.config.transport === 'forge') b.paused = true;
          this.disconnected(b);
        })
      });
      const target = b.pendingServer;
      b.pendingServer = undefined;
      if (target) {
        if (!b.transport.connectServer) throw new Error('UNSUPPORTED_ACTION');
        void b.transport.connectServer(target.host, target.port).catch(() => {
          if (this.stopped || b.connection !== connection) return;
          b.paused = true;
          this.log(b, 'server connect failed');
          this.disconnected(b);
        });
      }
    } catch {
      b.pendingServer = undefined;
      this.checkSessionAfterConnectFailure(b);
      if (this.config.transport === 'forge') b.paused = true;
      this.disconnected(b);
    }
  }
  private confirmJoinedInstance(b: ManagedBot, authoritativeLocation = false): void {
    if (b.machine.state !== 'JOINING_PIT' || !b.pendingInstance || (!b.joinSpawnObserved && !authoritativeLocation)) return;
    try { this.registry.join(b.pendingInstance, b.id, this.now()); }
    catch { this.log(b, 'registry full; membership rejected'); this.recover(b, 'UNKNOWN_RETURN'); return; }
    b.instanceId = b.pendingInstance; b.pendingInstance = undefined; b.joinSpawnObserved = false;
    b.pitPopulation=undefined;b.nextPitPopulationCheckAt=0;
    b.transport?.setInstance?.(b.instanceId);
    b.transport?.setPitScanEnabled?.(false);
    b.machine.transition('IN_PIT_IDLE'); b.stableSince = this.now();
    if(b.limboRecovery?.phase==='JOINING_PIT'){
      this.log(b,'lobby requeue completed',{source:b.limboRecovery.source,instanceId:b.instanceId});
      b.limboRecovery=undefined;
    }
    this.log(b, 'instance confirmed after transfer signals');
    this.checkPitPopulation(b);
  }
  private spawn(b: ManagedBot): void {
    b.ready = true;
    if(b.careRetryAt!==undefined&&b.carePackage){
      this.log(b,'care package death respawn observed',{scheduledAt:b.carePackage.timestamp});
      return;
    }
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
      b.machine.transition('LOBBY'); b.dueAt = this.now() + (this.config.transport === 'forge' ? 5000 : this.config.playCooldownMs);
    } else if (b.machine.state === 'JOINING_PIT') {
      // 1.8.9/Bungee event order is not assumed: accept either transfer-notice
      // ordering. If the notice was missed, ask Hypixel for the current raw
      // location only after spawn. A pending transfer notice is enough to
      // confirm here and must not trigger an extra /locraw request.
      b.joinSpawnObserved = true;
      b.transferLocrawAt = undefined;
      this.confirmJoinedInstance(b);
      if(b.machine.state==='JOINING_PIT'&&!b.pendingInstance){
        try{
          b.transport?.chat('/locraw');
          this.log(b,'Pit instance fallback requested',{source:'locraw'});
        }catch{
          this.log(b,'Pit instance fallback request failed');
        }
      }
    } else if (b.machine.state !== 'RECOVERING' && b.machine.state !== 'LOBBY' && b.machine.state !== 'PREPARING_EVENT') {
      this.recover(b, 'UNKNOWN_RETURN');
    }
  }
  private worldReset(b: ManagedBot): void {
    b.ready = false;
    if(b.careRetryAt!==undefined&&b.carePackage){
      this.log(b,'care package death world reset observed',{scheduledAt:b.carePackage.timestamp});
      return;
    }
    if (this.movementDebug) { this.cancelDebugWalk(b, true); b.debugWalkDone = false; b.debugSpawnAt = undefined; return; }
    if(b.limboRecovery?.phase==='WAIT_LOBBY'&&b.machine.state==='RECOVERING')return;
    if (b.machine.state === 'JOINING_PIT' || b.machine.state === 'CONNECTING') return;
    this.recover(b, 'UNKNOWN_RETURN'); b.deadline = this.now() + this.config.joinTimeoutMs;
  }
  private message(b: ManagedBot, text: string): void {
    if(isDeathNotice(text)){
      this.handleDeath(b);
      return;
    }
    if(isLimboNotice(text)){
      if(!['DISCONNECTED','CONNECTING'].includes(b.machine.state))this.recoverFromLimbo(b);
      return;
    }
    if (this.movementDebug) return;
    if(b.instanceId&&this.carePackages&&this.pitPopulationAllowsEvents(b)){
      const started=this.carePackages.observeAnnouncement(b.instanceId,text,this.now());
      if(started){
        this.log(b,'care package event started',{scheduledAt:started.timestamp,startedAt:started.startedAt,area:started.area});
        if(started.target)this.prepareCarePackage(b,started.timestamp,started.target);
      }
    }
    const transferInstance = parseInstance(text);
    const locrawInstance = parseLocrawPitInstance(text);
    const instance = transferInstance ?? locrawInstance;
    if(instance && b.instanceId===instance && b.machine.state==='IN_PIT_IDLE'){
      try{this.registry.heartbeat(instance,this.now());}catch{}
      this.log(b,'Pit instance confirmation repeated',{
        destination:instance,
        source:transferInstance?'transfer':'locraw'
      });
    } else if (instance && !['DISCONNECTED', 'CONNECTING'].includes(b.machine.state)) {
      if (b.machine.state !== 'JOINING_PIT') {
        this.recover(b, 'UNKNOWN_RETURN');
        b.machine.transition('JOINING_PIT');
        b.deadline = this.now() + this.config.joinTimeoutMs;
      }
      b.pendingInstance = instance;
      try { this.registry.observe(instance, this.now()); } catch { this.log(b, 'registry capacity reached'); }
      this.log(b, transferInstance?'transfer destination observed':'Pit instance observed from locraw',
        { destination: instance });
      if(locrawInstance){
        // A verified /locraw response naming The Pit is authoritative: it proves
        // the client already reached this backend even if the world/spawn event
        // was missed during the Bungee transfer.
        b.transferLocrawAt=undefined;
        this.confirmJoinedInstance(b,true);
      }else{
        this.confirmJoinedInstance(b);
        if(b.machine.state==='JOINING_PIT'&&!b.joinSpawnObserved){
          // Give the expected Bungee world reset/spawn a brief chance to arrive.
          // Only fall back to /locraw if spawn is still missing after two
          // manager ticks (Application ticks every 250ms).
          b.transferLocrawAt=this.now()+500;
        }
      }
    }
    const reason = this.classifier.classify(text);
    if (reason && b.machine.state !== 'DISCONNECTED' && b.machine.state !== 'CONNECTING') this.recover(b, reason);
  }
  private join(b: ManagedBot): void {
    if (b.joinAttempts >= this.config.joinMaxAttempts) {
      b.limboRecovery=undefined;
      b.paused = true; this.log(b, 'join attempt budget exhausted; inspect and restart after diagnosis'); return;
    }
    b.joinAttempts++; b.pendingInstance = undefined; b.joinSpawnObserved = false; b.transferLocrawAt=undefined;
    b.generation.invalidate(); b.machine.transition('JOINING_PIT');
    b.deadline = this.now() + this.config.joinTimeoutMs;
    try { b.transport?.chat('/play pit'); } catch { this.disconnected(b); }
  }
  private handleDeath(b:ManagedBot):void {
    const run=b.carePackage;
    this.log(b,'death detected',{carePackageActive:Boolean(run)});
    if(!run||!b.instanceId||b.instanceId!==run.instanceId||!this.carePackages?.isActive(run.instanceId,run.timestamp,this.now()))return;
    const eventId=run.chestEvent?.id;
    if(b.preparation)this.cancelPreparation(b);
    if(b.execution?.event.type==='care-package')this.cancelExecution(b,true);
    if(eventId)this.scheduler.jobs.delete(eventId);
    b.generation.invalidate();
    if(b.machine.state!=='IN_PIT_IDLE')return;
    b.careRetryAt=this.now()+250;
    this.log(b,'care package death retry queued',{scheduledAt:run.timestamp,retryDelayMs:250});
  }
  private stopCarePackage(b:ManagedBot,reason:'CHEST_DISAPPEARED'|'EXPIRED'):void {
    const run=b.carePackage;
    if(!run)return;
    b.careRetryAt=undefined;
    if(b.preparation?.timestamp===run.timestamp)this.cancelPreparation(b);
    if(b.execution?.event.type==='care-package'&&b.execution.event.instanceId===run.instanceId)this.cancelExecution(b,true);
    const eventId=run.chestEvent?.id??`care-package:${run.timestamp}:${run.instanceId}`;
    this.scheduler.jobs.delete(eventId);
    b.carePackage=undefined;
    b.generation.invalidate();
    this.log(b,'care package execution stopped',{scheduledAt:run.timestamp,reason});
  }
  private pitPopulationAllowsEvents(b:ManagedBot):boolean {
    return this.config.transport!=='forge'||this.config.pitEventMinPlayers<=0||
      (b.pitPopulation!==undefined&&b.pitPopulation>=this.config.pitEventMinPlayers);
  }

  private checkPitPopulation(b:ManagedBot):void {
    const minimum=this.config.pitEventMinPlayers;
    const transport=b.transport;
    const instanceId=b.instanceId;
    const connection=b.connection;
    if(!instanceId)return;
    if(this.config.transport!=='forge'){
      transport?.setPitScanEnabled?.(true);
      return;
    }
    if(minimum<=0){
      transport?.setPitScanEnabled?.(true);
      return;
    }
    if(!transport?.playerCount){
      // Legacy transports cannot verify population. Do not block their existing behavior.
      transport?.setPitScanEnabled?.(true);
      return;
    }
    if(b.pitPopulationCheckInstance===instanceId)return;

    b.pitPopulationCheckInstance=instanceId;
    b.nextPitPopulationCheckAt=this.now()+this.config.pitPopulationCheckMs;
    void transport.playerCount().then(count=>{
      if(this.stopped||b.connection!==connection||b.instanceId!==instanceId)return;
      if(count===undefined){
        b.pitPopulation=undefined;
        transport.setPitScanEnabled?.(false);
        this.log(b,'Pit lobby population unavailable',{instanceId,minimum});
        return;
      }

      b.pitPopulation=count;
      this.log(b,'Pit lobby population observed',{instanceId,players:count,minimum});
      if(count>=minimum){
        transport.setPitScanEnabled?.(true);
        return;
      }

      transport.setPitScanEnabled?.(false);
      if(b.machine.state==='IN_PIT_IDLE'){
        this.startLobbyRequeue(b,'LOW_POPULATION',0,{players:count,minimum,instanceId});
      }
    },()=>{
      if(!this.stopped&&b.connection===connection&&b.instanceId===instanceId){
        b.pitPopulation=undefined;
        transport.setPitScanEnabled?.(false);
        this.log(b,'Pit lobby population query failed',{instanceId,minimum});
      }
    }).finally(()=>{
      if(b.pitPopulationCheckInstance===instanceId)b.pitPopulationCheckInstance=undefined;
    });
  }

  private startLobbyRequeue(
    b:ManagedBot,
    source:'LOW_POPULATION'|'DISTRIBUTION',
    delayMs=0,
    extra:Record<string,unknown>={}
  ):void {
    if(b.limboRecovery||['DISCONNECTED','CONNECTING'].includes(b.machine.state))return;
    const now=this.now();
    b.carePackage=undefined;b.careRetryAt=undefined;b.activity=undefined;
    b.transport?.setInstance?.(undefined);
    this.cancelDebugWalk(b,true);this.cancelPreparation(b);this.cancelExecution(b,false);b.generation.invalidate();
    this.registry.leave(b.id,now,'PLANNED');
    b.instanceId=undefined;b.pendingInstance=undefined;b.joinSpawnObserved=false;b.transferLocrawAt=undefined;b.stableSince=undefined;b.ready=false;
    b.pitPopulation=undefined;b.pitPopulationCheckInstance=undefined;b.nextPitPopulationCheckAt=0;
    b.machine.transition('RECOVERING');
    b.limboRecovery={playAt:now+delayMs,phase:'WAIT_LOBBY',source};
    b.deadline=now+delayMs+this.config.joinTimeoutMs;
    b.dueAt=Number.POSITIVE_INFINITY;
    this.log(b,'lobby requeue started',{source,delayMs,...extra});
    try{b.transport?.chat(this.config.lobbyCommand??'/l');}
    catch{b.limboRecovery=undefined;this.disconnected(b);}
  }

  private recoverFromLimbo(b:ManagedBot):void {
    if(b.limboRecovery)return;
    const now=this.now();
    b.carePackage=undefined;b.careRetryAt=undefined;b.activity=undefined;
    b.transport?.setInstance?.(undefined);
    this.cancelDebugWalk(b,true);this.cancelPreparation(b);this.cancelExecution(b,false);b.generation.invalidate();
    this.registry.leave(b.id,now,'LIMBO');
    b.instanceId=undefined;b.pendingInstance=undefined;b.joinSpawnObserved=false;b.transferLocrawAt=undefined;b.stableSince=undefined;b.ready=false;
    b.machine.transition('RECOVERING');
    b.limboRecovery={playAt:now+2000,phase:'WAIT_LOBBY',source:'LIMBO'};
    b.deadline=now+2000+this.config.joinTimeoutMs;
    b.dueAt=Number.POSITIVE_INFINITY;
    this.log(b,'limbo detected; starting special recovery',{
      lobbyCommand:'/l',
      pitDelayMs:2000,
      pingMs:b.transport?.ping?.(),
      sincePositionCorrectionMs:b.lastPositionCorrectionAt===undefined?null:Math.max(0,now-b.lastPositionCorrectionAt)
    });
    try{b.transport?.chat('/l');}
    catch{b.limboRecovery=undefined;this.disconnected(b);}
  }
  private recover(b: ManagedBot, reason: ReturnReason): void {
    b.limboRecovery=undefined;b.carePackage=undefined;b.careRetryAt=undefined;b.activity=undefined;
    b.transport?.setInstance?.(undefined);
    this.cancelDebugWalk(b, true); this.cancelPreparation(b); this.cancelExecution(b, false); b.generation.invalidate();
    this.registry.leave(b.id, this.now(), reason);
    b.instanceId = undefined; b.pendingInstance = undefined; b.joinSpawnObserved = false; b.transferLocrawAt = undefined; b.stableSince = undefined;
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
  private serverDisconnected(b: ManagedBot): void {
    if (b.machine.state === 'DISCONNECTED') return;
    b.transport?.setInstance?.(undefined);
    this.cancelDebugWalk(b, true); this.cancelPreparation(b); this.cancelExecution(b, false); b.generation.invalidate();
    this.registry.leave(b.id, this.now(), 'DISCONNECT');
    b.limboRecovery=undefined;b.carePackage=undefined;b.careRetryAt=undefined;b.activity=undefined;
    b.instanceId = undefined; b.pendingInstance = undefined; b.pendingServer = undefined; b.joinSpawnObserved = false; b.transferLocrawAt = undefined; b.stableSince = undefined; b.ready = false; b.debugWalkDone = false;
    b.debugSpawnAt = undefined; b.lastPositionCorrectionAt = undefined; b.lastHorizontalCollisionAt = undefined;
    b.machine.transition('DISCONNECTED');
    b.dueAt = 0;
  }

  private disconnected(b: ManagedBot): void {
    if (b.machine.state === 'DISCONNECTED') {
      const transport = b.transport; b.transport = undefined; b.connection++;
      try { transport?.close(); } catch { this.log(b, 'transport close failed'); }
      return;
    }
    b.transport?.setInstance?.(undefined);
    this.cancelDebugWalk(b, true); this.cancelPreparation(b); this.cancelExecution(b, false); b.generation.invalidate(); b.connection++;
    this.registry.leave(b.id, this.now(), this.stopped ? 'PLANNED' : 'DISCONNECT');
    b.limboRecovery=undefined;b.carePackage=undefined;b.careRetryAt=undefined;b.activity=undefined;
    b.instanceId = undefined; b.pendingInstance = undefined; b.pendingServer = undefined; b.joinSpawnObserved = false; b.transferLocrawAt = undefined; b.stableSince = undefined; b.ready = false; b.debugWalkDone = false;
    const transport = b.transport; b.transport = undefined;
    b.debugSpawnAt = undefined; b.lastPositionCorrectionAt = undefined; b.lastHorizontalCollisionAt = undefined;
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
    const instanceId=bot.instanceId;
    if(!instanceId)return;
    const expiresAt=this.carePackages.expiresAt(instanceId,timestamp);
    const existing=bot.carePackage;
    if(!existing||existing.timestamp!==timestamp||existing.instanceId!==instanceId){
      bot.carePackage={timestamp,instanceId,target:{...target},expiresAt};
    }else{
      existing.target={...target};existing.expiresAt=expiresAt;
    }
    const preparation:EventPreparation={timestamp,generation:bot.generation.current,abort:new AbortController(),
      expiresAt,chestEvent:bot.carePackage?.chestEvent};
    bot.preparation=preparation; bot.machine.transition('PREPARING_EVENT');
    this.carePackages.markLaunch(instanceId,timestamp,'LAUNCHING');
    this.log(bot,'care package launch started',{scheduledAt:timestamp,targetX:target.x,targetZ:target.z});
    void transport.launchToward!({x:target.x,z:target.z},preparation.abort.signal,'LANDING').then(()=>{
      if(bot.preparation!==preparation||!bot.generation.isCurrent(preparation.generation)||!bot.instanceId)return;
      preparation.launched=true;
      this.carePackages?.markLaunch(bot.instanceId,timestamp,'DROPPED');
      this.log(bot,'care package launch completed',{scheduledAt:timestamp,completion:'LANDING'});
      if(preparation.chestEvent){
        this.continuePreparedCarePackage(bot,preparation);
        return;
      }
      const position=transport.position();
      if(!position){
        this.log(bot,'care package prediction unavailable',{scheduledAt:timestamp});
        return;
      }
      this.startCarePackagePrediction(bot,preparation,{x:target.x,y:position.y,z:target.z});
    },error=>{
      if(bot.preparation!==preparation||!bot.generation.isCurrent(preparation.generation)||!bot.instanceId)return;
      this.carePackages?.markLaunch(bot.instanceId,timestamp,'LAUNCH_FAILED');
      this.log(bot,'care package launch failed',{
        scheduledAt:timestamp,
        reason:error instanceof PathfindingError?error.code:this.movementFailure(error)
      });
      const fallback=preparation.chestEvent;
      bot.preparation=undefined;
      if(bot.machine.state==='PREPARING_EVENT')bot.machine.transition('IN_PIT_IDLE');
      if(fallback)this.scheduler.enqueue(fallback,this.now());
    });
  }
  private startCarePackagePrediction(bot:ManagedBot,preparation:EventPreparation,target:Position):void {
    if(bot.preparation!==preparation||!preparation.launched||preparation.chestEvent||!bot.transport||
      !bot.generation.isCurrent(preparation.generation)||!bot.instanceId)return;
    const controller=new AbortController();
    preparation.predictionAbort=controller;
    preparation.predictionTarget={...target};
    const transport=bot.transport;
    const queuedAt=this.now();
    bot.pathAttempts++;
    this.log(bot,'care package prediction path started',{
      scheduledAt:preparation.timestamp,targetX:target.x,targetY:target.y,targetZ:target.z
    });
    void this.paths.submit(`care-prediction:${bot.id}:${preparation.timestamp}:${preparation.generation}`,controller.signal,async signal=>{
      const startedAt=this.now();bot.pathStartedAt=startedAt;bot.lastPathQueueMs=Math.max(0,startedAt-queuedAt);
      try{await transport.navigate(target,signal);bot.pathCompleted++;}
      catch(error){if(!signal.aborted)bot.pathFailed++;throw error;}
      finally{if(bot.pathStartedAt===startedAt){bot.lastPathMs=Math.max(0,this.now()-startedAt);bot.pathStartedAt=undefined;}}
    },()=>transport.stopPath()).then(()=>{
      if(bot.preparation!==preparation||!bot.generation.isCurrent(preparation.generation))return;
      preparation.predictionAbort=undefined;
      this.log(bot,'care package prediction reached',{
        scheduledAt:preparation.timestamp,targetX:target.x,targetY:target.y,targetZ:target.z
      });
      if(preparation.chestEvent)this.continuePreparedCarePackage(bot,preparation);
      else this.log(bot,'care package waiting for chest',{scheduledAt:preparation.timestamp});
    },error=>{
      if(bot.preparation!==preparation||!bot.generation.isCurrent(preparation.generation))return;
      preparation.predictionAbort=undefined;
      if(preparation.chestEvent){
        this.continuePreparedCarePackage(bot,preparation);
        return;
      }
      this.log(bot,'care package prediction path failed',{
        scheduledAt:preparation.timestamp,
        reason:error instanceof PathfindingError?error.code:this.movementFailure(error)
      });
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
    const preparation=b.preparation;b.preparation=undefined;
    preparation?.predictionAbort?.abort();preparation?.abort.abort();
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
    const execution: Execution = { id, lease, generation: b.generation.current, abort: new AbortController(), event };
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

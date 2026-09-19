import { createBot, type BotOptions } from 'mineflayer';
import pathfinderModule from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderModule;
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parseInstance } from '../instances/parser.js';
import { eligibleServerAnnouncementChannel, eligibleTransferChannel } from './message-source.js';
import { parseCarePackageAnnouncement } from '../events/care-package.js';
import type { Config } from '../config/index.js';
import type { BotTransport, TransportEvents } from './transport.js';
import { readSessionCredential } from '../runtime/session.js';
type ViewerStarter = (bot: ReturnType<typeof createBot>, options: { port: number; firstPerson: boolean; viewDistance: number }) => void;
type ViewerModule = { mineflayer?: ViewerStarter };
const require = createRequire(import.meta.url);
type ViewerBot = ReturnType<typeof createBot> & { viewer?: { close(): void } };
/** The only module allowed to import Mineflayer. */
export function createBotOptions(config: Config, index: number): BotOptions {
  const account = config.accounts[index]!;
  const common = {
    host: config.host,
    port: config.port,
    version: config.version,
    hideErrors: true,
    logErrors: false,
    // Mineflayer normally catches up several missed 50 ms physics steps in one
    // timer callback. On Windows that can turn into movement-packet bursts only
    // a few milliseconds apart. Vanilla 1.8.9 advances one client tick at a time,
    // so keep legacy movement delivery paced instead of bursting catch-up ticks.
    maxCatchupTicks: config.version === '1.8.9' ? 1 : 4
  };
  if (account.kind === 'SESSION') return { ...common, username: account.username,
    auth: 'mojang', session: readSessionCredential(config.authDir, account.accountId),
    skipValidation: true, profilesFolder: false };
  return { ...common, username: account.username, auth: account.auth,
    profilesFolder: join(config.authDir, account.label),
    onMsaCode: data => process.stderr.write(`[${account.label}] Microsoft sign-in: ${data.verification_uri} code: ${data.user_code}\n`) };
}
export function createMineflayerTransport(config: Config, index: number, events: TransportEvents): BotTransport {
  const account = config.accounts[index]!;
  const bot = createBot(createBotOptions(config, index));
  bot.loadPlugin(pathfinder);
  let closed = false;
  let viewerStarted = false;
  let viewerStarting = false;
  let lastSpawnAt = 0;
  let correctionTraceUntil = 0;
  let correctionTraceRemaining = 0;
  let correctionAckPending = 0;
  let correctionSequence = 0;
  let lastWireYaw: number | undefined;
  let pendingCorrectionAckYaw: number | undefined;
  let legacyReportedPosition: { x:number; y:number; z:number } | undefined;
  let legacyPositionUpdateTicks = 0;
  let lastCorrectionAt = 0;
  let lastBotVelocityAt = 0;
  let lastBotVelocity: { x:number; y:number; z:number } | undefined;
  let lastSprintActionAt = 0;
  let lastSprintAction: 'START' | 'STOP' | undefined;
  let lastServerMovementAttributeAt = 0;
  let lastServerMovementAttribute: { value:number; effective:number; modifiers:string; sprintModifier:boolean; x:number|null; y:number|null; z:number|null } | undefined;
  let lastServerAbilitiesAt = 0;
  let lastServerAbilities: { flags:number; flyingSpeed:number; walkingSpeed:number } | undefined;
  const movementPacketTimes:number[] = [];
  const movementHistory:Array<{at:number;packet:string;x:number;y:number;z:number;yaw:number|null;onGround:boolean|null}> = [];
  const sprintActionTimes:number[] = [];
  const stopPath = () => { bot.clearControlStates(); };
  const isPartialSlab = (block: { name?: string } | null | undefined) =>
    typeof block?.name === 'string' && block.name.includes('slab') && !block.name.includes('double');
  const walkingMovements = () => {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.allowSprinting = true;
    movements.scafoldingBlocks = [];
    movements.allowFreeMotion = false;
    // Prefer full-block footing without making slab-only routes impossible.
    // Pathfinder step exclusions are costs below 100; a hard 100+ would make Pit slab routes unroutable.
    movements.exclusionAreasStep.push(block => {
      const support = block?.position ? bot.blockAt(block.position.offset(0,-1,0)) : null;
      return isPartialSlab(block) || isPartialSlab(support) ? 12 : 0;
    });
    return movements;
  };
  const angleDelta = (target:number,current:number) => {
    let value = target-current;
    while (value > Math.PI) value -= Math.PI*2;
    while (value < -Math.PI) value += Math.PI*2;
    return value;
  };
  const turnToward = async (target:{x:number;y:number;z:number}, signal:AbortSignal) => {
    for (let ticks=0;ticks<30;ticks++) {
      signal.throwIfAborted();
      const p=bot.entity?.position;
      if(!p)throw new Error('Position unavailable');
      const dx=target.x-p.x,dz=target.z-p.z;
      const yaw=Math.atan2(-dx,-dz);
      const turn=angleDelta(yaw,bot.entity.yaw);
      if(Math.abs(turn)<=0.04)return;
      const step=Math.max(-0.12,Math.min(0.12,turn));
      void bot.look(bot.entity.yaw+step,bot.entity.pitch,false);
      await bot.waitForTicks(1);
    }
    throw new Error('Control turn timeout');
  };
  const controlWalk = async (target:{x:number;y:number;z:number}, range:number, signal:AbortSignal) => {
    signal.throwIfAborted();
    const started = Date.now();
    const maxReplans = 3;
    for (let replan = 0; replan <= maxReplans; replan++) {
      signal.throwIfAborted();
      const movements = walkingMovements();
      const goal = new goals.GoalNear(target.x,target.y,target.z,range);
      const planner = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, {
        timeout: Math.max(1, config.pathTimeoutMs - (Date.now()-started)),
        tickTimeout: bot.pathfinder.tickTimeout
      });
      let plan: ReturnType<typeof bot.pathfinder.getPathTo> | undefined;
      while (true) {
        signal.throwIfAborted();
        const next = planner.next();
        if (next.done) break;
        plan = next.value.result;
        if (plan.status !== 'partial') break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (!plan || plan.status !== 'success') {
        const status = plan?.status ?? 'noPath';
        events.diagnostic?.('control path planning failed',{
          status,visitedNodes:plan?.visitedNodes??null,generatedNodes:plan?.generatedNodes??null,
          planningMs:plan?.time??null,targetX:target.x,targetY:target.y,targetZ:target.z,replan
        });
        throw new Error(status === 'noPath' ? 'No path to the goal!' : 'Path planning timeout');
      }
      const slabNodes = plan.path.reduce((count, waypoint) => {
        const origin = bot.entity.position;
        const footing = bot.blockAt(origin.offset(waypoint.x-origin.x,waypoint.y-0.01-origin.y,waypoint.z-origin.z));
        return count + (isPartialSlab(footing) ? 1 : 0);
      },0);
      events.diagnostic?.('control path planned',{nodes:plan.path.length,slabNodes,targetX:target.x,targetY:target.y,targetZ:target.z,replan});

      let collisionReplan = false;
      try {
        for (const waypoint of plan.path) {
          let best = Number.POSITIVE_INFINITY;
          let lastProgress = Date.now();
          while (true) {
            signal.throwIfAborted();
            if (Date.now()-started > config.pathTimeoutMs) throw new Error('Control walk timeout');
            const p = bot.entity?.position;
            if (!p) throw new Error('Position unavailable');
            const dx = waypoint.x-p.x, dz = waypoint.z-p.z, dy = waypoint.y-p.y;
            const horizontal = Math.hypot(dx,dz);
            // A one-block-up waypoint must not be treated as reached before the jump.
            if (horizontal <= 0.42 && Math.abs(dy) < 0.35) break;
            const spatial = Math.hypot(horizontal,dy);
            if (spatial < best-0.03) { best=spatial; lastProgress=Date.now(); }
            else if (Date.now()-lastProgress > 3000) throw new Error('Control walk stuck');

            const yaw = Math.atan2(-dx,-dz);
            const turn = angleDelta(yaw,bot.entity.yaw);
            if (Math.abs(turn) > 0.04) {
              const step = Math.max(-0.12,Math.min(0.12,turn));
              void bot.look(bot.entity.yaw+step,bot.entity.pitch,false);
            }
            signal.throwIfAborted();

            const remainingTurn = Math.abs(angleDelta(yaw,bot.entity.yaw));
            const aligned = remainingTurn <= 0.28;
            const needsJump = dy > 0.35;
            const runtimeEntity = bot.entity as typeof bot.entity & { isCollidedHorizontally?:boolean };
            const collided = Boolean(runtimeEntity.isCollidedHorizontally);

            if (collided && !needsJump && aligned) {
              bot.clearControlStates();
              events.diagnostic?.('control walk collision',{
                waypointX:waypoint.x,waypointY:waypoint.y,waypointZ:waypoint.z,
                x:p.x,y:p.y,z:p.z,replan
              });
              collisionReplan = true;
              break;
            }

            // Keep W+sprint latched through small waypoint steering changes.
            // Requiring <=0.28 rad every tick made short path segments alternate
            // START/STOP_SPRINTING many times per second. A vanilla player keeps
            // the keys held while making ordinary gentle turns; only pause them
            // for a genuinely sharp turn, collision, or jump setup.
            const keepTurn = remainingTurn <= 0.70;
            const wasForward = bot.getControlState('forward');
            const wasSprint = bot.getControlState('sprint');
            const moveForward = !collided && (aligned || (!needsJump && wasForward && keepTurn));
            const canSprint = moveForward && !needsJump && (aligned || (wasSprint && keepTurn));
            bot.setControlState('sneak',false);
            bot.setControlState('back',false);
            bot.setControlState('left',false);
            bot.setControlState('right',false);
            bot.setControlState('forward',moveForward);
            bot.setControlState('sprint',canSprint);
            bot.setControlState('jump',aligned && needsJump && bot.entity.onGround);
            await bot.waitForTicks(1);
          }
          bot.setControlState('jump',false);
          if (collisionReplan) break;
        }
      } finally {
        bot.clearControlStates();
      }

      if (collisionReplan) {
        if (replan >= maxReplans) throw new Error('Control walk collision');
        await bot.waitForTicks(1);
        continue;
      }

      const p = bot.entity?.position;
      if (!p || Math.hypot(p.x-target.x,p.z-target.z) > range+0.9 || Math.abs(p.y-target.y) > 1.5) throw new Error('Control walk ended before arrival');
      return;
    }
    throw new Error('Control walk collision');
  };
  const waitUntilGrounded = async (signal:AbortSignal) => {
    const started=Date.now();
    while(!bot.entity?.onGround){
      signal.throwIfAborted();
      if(Date.now()-started>Math.min(config.pathTimeoutMs,10_000))throw new Error('Landing wait timeout');
      await bot.waitForTicks(1);
    }
  };
  const reportIdentity = () => {
    const username = bot.username;
    if (typeof username === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(username)) events.identity?.(username);
  };
  const startViewer = async () => {
    const botId = `bot-${index + 1}`;
    if (!config.viewer.enabled || config.viewer.botId !== botId || viewerStarted || viewerStarting || closed) return;
    viewerStarting = true;
    try {
      // prismarine-viewer is CommonJS. createRequire avoids Node ESM interop differences.
      // Keep it optional so normal BBot installs and CI do not pull a renderer stack.
      const loaded = require('prismarine-viewer') as ViewerModule;
      const mineflayerViewer = loaded.mineflayer;
      if (typeof mineflayerViewer !== 'function') throw new Error('mineflayer viewer export missing');
      events.diagnostic?.('viewer start requested', { botId, port: config.viewer.port });
      mineflayerViewer(bot, {
        port: config.viewer.port,
        firstPerson: config.viewer.firstPerson,
        viewDistance: config.viewer.viewDistance
      });
      let ready = false;
      for (let attempt = 0; attempt < 15 && !closed; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        try {
          const response = await fetch(`http://127.0.0.1:${config.viewer.port}/`, { signal: AbortSignal.timeout(500) });
          if (response.ok) { ready = true; break; }
        } catch { /* Viewer may still be binding. */ }
      }
      if (!ready) throw new Error('viewer port did not become ready');
      viewerStarted = true;
      events.diagnostic?.('viewer started', { botId, port: config.viewer.port, firstPerson: config.viewer.firstPerson, viewDistance: config.viewer.viewDistance });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
      process.stderr.write(`[${account.label}] Viewer could not start: ${reason}\n`);
      events.diagnostic?.('viewer start failed', { botId, port: config.viewer.port, reason });
    } finally {
      viewerStarting = false;
    }
  };
  const spawn = () => {
    lastSpawnAt = Date.now();
    const movements = walkingMovements();
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.tickTimeout = 10;
    bot.pathfinder.thinkTimeout = config.pathTimeoutMs;
    events.diagnostic?.('spawn observed', { inventorySlots: bot.inventory?.slots.length ?? null });
    reportIdentity();
    void startViewer();
    events.spawn();
  };
  const reset = () => { events.diagnostic?.('respawn observed'); events.worldReset(); };
  const windowOpen = () => events.diagnostic?.('window opened');
  const windowClose = () => events.diagnostic?.('window closed');
  const message = (text: string, position: string, _json: unknown, sender?: string | null) => {
    // On legacy protocol, the network may deliver server text in chat (unverified).
    // Observe likely transfer messages without recording their contents. Chat requires explicit opt-in.
    const clean = text.replace(/§[0-9a-fk-or]/gi, '').trim();
    const chatText = clean.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
    if (chatText) events.diagnostic?.('chat message received', {
      channel: position,
      senderPresent: Boolean(sender),
      chatText
    });
    const lower = clean.toLowerCase();
    const candidate = parseInstance(text);
    const eligible = eligibleTransferChannel(position, sender, config.transferMessageChannel, candidate !== undefined);
    const careAnnouncement = parseCarePackageAnnouncement(text);
    const careEligible = eligibleServerAnnouncementChannel(position, sender, careAnnouncement !== undefined);
    const looksTransferRelated =
      candidate !== undefined ||
      lower.includes('server found') ||
      lower.includes('sending to') ||
      (lower.includes('server') && lower.includes('sending'));
    if (looksTransferRelated) {
      events.diagnostic?.('transfer-like text observed', {
        channel: position,
        senderPresent: Boolean(sender),
        selectedChannel: config.transferMessageChannel,
        eligible,
        exactPatternMatch: candidate !== undefined,
        hasServerFound: lower.includes('server found'),
        hasSendingTo: lower.includes('sending to')
      });
    }
    if (careAnnouncement) {
      events.diagnostic?.('care package announcement observed', {
        channel: position, senderPresent: Boolean(sender), eligible: careEligible, area: careAnnouncement.area
      });
    }
    if (!eligible && !careEligible) return;
    events.message(text);
  };
  const normalizeKickReason = (reason: unknown): string => {
    try {
      if (typeof reason === 'string') return reason.replace(/[\r\n]+/g, ' ').slice(0, 1000);
      const rendered = String(reason);
      if (rendered && rendered !== '[object Object]') return rendered.replace(/[\r\n]+/g, ' ').slice(0, 1000);
      return JSON.stringify(reason).replace(/[\r\n]+/g, ' ').slice(0, 1000);
    } catch {
      return 'Unknown kick reason';
    }
  };
  const kicked = (reason: unknown, loggedIn?: boolean) => {
    if (closed) return;
    events.kicked?.(normalizeKickReason(reason), loggedIn);
  };
  const end = () => { if (!closed) events.end(); };
  const error = () => { if (!closed) events.error(); };
  const entitySpawn = (entity: { name?: string; displayName?: string; position?: { x:number;y:number;z:number } }) => {
    if (closed || !entity.position) return;
    if (entity.name === 'chicken' || entity.displayName === 'Chicken') {
      events.chickenSpawn?.({ x: entity.position.x, y: entity.position.y, z: entity.position.z });
    }
  };
  const blockUpdate = (oldBlock: { name?: string } | null, newBlock: { name?: string; position?: { x:number;y:number;z:number } } | null) => {
    if (closed || !newBlock?.position || newBlock.name !== 'chest' || oldBlock?.name === 'chest') return;
    events.chestAppeared?.({ x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z });
  };
  const positionPacket = (packet: { x:number; y:number; z:number; yaw:number; flags:number | {x?:boolean;y?:boolean;z?:boolean;yaw?:boolean} }) => {
    if (closed || !bot.entity?.position) return;
    const receivedAt=Date.now();
    correctionTraceUntil = receivedAt + 500;
    correctionTraceRemaining = 10;
    correctionAckPending++;
    correctionSequence++;
    const before = bot.entity.position;
    const relative = typeof packet.flags === 'object'
      ? { x:Boolean(packet.flags.x), y:Boolean(packet.flags.y), z:Boolean(packet.flags.z), yaw:Boolean(packet.flags.yaw) }
      : { x:Boolean(packet.flags & 1), y:Boolean(packet.flags & 2), z:Boolean(packet.flags & 4), yaw:Boolean(packet.flags & 8) };
    if(config.version==='1.8.9' && Number.isFinite(packet.yaw)){
      pendingCorrectionAckYaw=relative.yaw && lastWireYaw!==undefined ? lastWireYaw+packet.yaw : packet.yaw;
    }
    const target = {
      x: relative.x ? before.x + packet.x : packet.x,
      y: relative.y ? before.y + packet.y : packet.y,
      z: relative.z ? before.z + packet.z : packet.z
    };
    const horizontal = Math.hypot(target.x-before.x,target.z-before.z);
    const vertical = target.y-before.y;
    const feetBlock = bot.blockAt(before);
    const floorBlock = bot.blockAt(before.offset(0,-0.01,0));
    const supportSummary = (point:{x:number;y:number;z:number}) => {
      const seen=new Set<string>();
      const parts:string[]=[];
      for(const ox of [-0.31,0,0.31]) for(const oz of [-0.31,0,0.31]) for(const oy of [-0.01,-0.51,-1.01]){
        const sample=before.offset(point.x-before.x+ox, point.y-before.y+oy, point.z-before.z+oz);
        const block=bot.blockAt(sample) as unknown as { name?:string; metadata?:number; position?:{x:number;y:number;z:number}; shapes?:number[][] } | null;
        if(!block?.position||block.name==='air')continue;
        const key=`${block.position.x},${block.position.y},${block.position.z}`;
        if(seen.has(key))continue;
        seen.add(key);
        const shapes=(block.shapes??[]).map(shape=>shape.map(value=>Math.round(value*100)/100).join(',')).join('|');
        parts.push(`${block.name}:${block.metadata??'?'}@${key}[${shapes||'no-shape'}]`);
      }
      return parts.slice(0,12).join(';')||'none';
    };
    const beforeSupport=supportSummary(before);
    const targetSupport=supportSummary(target);
    const runtimeEntity = bot.entity as typeof bot.entity & { attributes?: Record<string, unknown> };
    const runtimeBot = bot as typeof bot & { abilities?: { walkingSpeed?: number } };
    const effects = runtimeEntity.effects ?? {};
    const effectSummary = Object.values(effects).map(effect => {
      const value = effect as { id?:number; amplifier?:number; duration?:number };
      return `${value.id ?? '?'}:${value.amplifier ?? '?'}:${value.duration ?? '?'}`;
    }).slice(0,8).join(',');
    const attributes = runtimeEntity.attributes ?? {};
    const movementEntry = Object.entries(attributes).find(([key]) => /movement.*speed|speed.*movement/i.test(key));
    const movementAttribute = movementEntry?.[1] as { value?:number; modifiers?:Array<{amount?:number;operation?:number}> } | undefined;
    const modifiers = movementAttribute?.modifiers ?? [];
    const modifierSummary = modifiers.map(modifier =>
      `${typeof modifier.amount === 'number' ? Math.round(modifier.amount*10000)/10000 : '?'}:${typeof modifier.operation === 'number' ? modifier.operation : '?'}`
    ).slice(0,8).join(',');
    let effectiveMovementSpeed = typeof movementAttribute?.value === 'number' ? movementAttribute.value : undefined;
    if (effectiveMovementSpeed !== undefined) {
      const baseAfterAdd = effectiveMovementSpeed + modifiers.filter(m=>m.operation===0).reduce((sum,m)=>sum+(m.amount ?? 0),0);
      let value = baseAfterAdd;
      value += baseAfterAdd * modifiers.filter(m=>m.operation===1).reduce((sum,m)=>sum+(m.amount ?? 0),0);
      for (const modifier of modifiers) if (modifier.operation===2) value += value * (modifier.amount ?? 0);
      effectiveMovementSpeed = value;
    }
    const now=receivedAt;
    const sinceCorrectionMs=lastCorrectionAt?now-lastCorrectionAt:null;
    lastCorrectionAt=now;
    const packetTimes=movementPacketTimes.filter(at=>now-at<=1000);
    const packetGaps=packetTimes.slice(1).map((at,i)=>at-packetTimes[i]!);
    const sprintActions=sprintActionTimes.filter(at=>now-at<=2000);
    const recentMovement=movementHistory.filter(sample=>now-sample.at<=3000);
    let nearestSent:typeof recentMovement[number] | undefined;
    let nearestSentDistance=Number.POSITIVE_INFINITY;
    let nearestSentIndex=-1;
    for(let i=0;i<recentMovement.length;i++){
      const sample=recentMovement[i]!;
      const distance=Math.hypot(sample.x-target.x,sample.z-target.z,Math.min(4,Math.abs(sample.y-target.y)));
      if(distance<nearestSentDistance){nearestSentDistance=distance;nearestSent=sample;nearestSentIndex=i;}
    }
    const lastSent=recentMovement.at(-1);
    const recentSteps=recentMovement.slice(1).map((sample,index)=>({
      horizontal:Math.hypot(sample.x-recentMovement[index]!.x,sample.z-recentMovement[index]!.z),
      gapMs:sample.at-recentMovement[index]!.at
    })).filter(step=>step.gapMs>0&&step.gapMs<=120);
    const lastStep=recentSteps.at(-1);
    const maxStep=recentSteps.length?Math.max(...recentSteps.map(step=>step.horizontal)):null;
    events.diagnostic?.('server position correction', {
      sinceSpawnMs: lastSpawnAt ? now-lastSpawnAt : null,
      sinceCorrectionMs,
      pingMs:typeof bot.player?.ping==='number'&&Number.isFinite(bot.player.ping)?bot.player.ping:null,
      normalMovementPackets1s:packetTimes.length,
      minMovementPacketGapMs:packetGaps.length?Math.min(...packetGaps):null,
      maxMovementPacketGapMs:packetGaps.length?Math.max(...packetGaps):null,
      movementPacketBursts:packetGaps.filter(gap=>gap<20).length,
      nearestSentAgeMs:nearestSent?now-nearestSent.at:null,
      nearestSentPacketsAgo:nearestSent?recentMovement.length-1-nearestSentIndex:null,
      nearestSentDistance:Number.isFinite(nearestSentDistance)?Math.round(nearestSentDistance*1000)/1000:null,
      nearestSentX:nearestSent?.x??null,
      nearestSentY:nearestSent?.y??null,
      nearestSentZ:nearestSent?.z??null,
      lastSentAgeMs:lastSent?now-lastSent.at:null,
      lastSentTargetDistance:lastSent?Math.round(Math.hypot(lastSent.x-target.x,lastSent.z-target.z,Math.min(4,Math.abs(lastSent.y-target.y)))*1000)/1000:null,
      lastMovementStep:lastStep?Math.round(lastStep.horizontal*1000)/1000:null,
      maxMovementStep:maxStep===null?null:Math.round(maxStep*1000)/1000,
      sinceServerAbilitiesMs:lastServerAbilitiesAt?now-lastServerAbilitiesAt:null,
      serverAbilityFlags:lastServerAbilities?.flags??null,
      serverFlyingSpeed:lastServerAbilities?.flyingSpeed??null,
      serverWalkingSpeed:lastServerAbilities?.walkingSpeed??null,
      sprintActions2s:sprintActions.length,
      lastSprintAction:lastSprintAction??null,
      sinceSprintActionMs:lastSprintActionAt?now-lastSprintActionAt:null,
      sinceServerMovementAttributeMs:lastServerMovementAttributeAt?now-lastServerMovementAttributeAt:null,
      serverMovementAttributeX:lastServerMovementAttribute?.x??null,
      serverMovementAttributeY:lastServerMovementAttribute?.y??null,
      serverMovementAttributeZ:lastServerMovementAttribute?.z??null,
      serverMovementAttributeTargetDistance:lastServerMovementAttribute?.x!==null&&lastServerMovementAttribute?.x!==undefined&&lastServerMovementAttribute.z!==null&&lastServerMovementAttribute.z!==undefined
        ? Math.round(Math.hypot(lastServerMovementAttribute.x-target.x,lastServerMovementAttribute.z-target.z)*1000)/1000 : null,
      serverMovementAttributeValue:lastServerMovementAttribute?.value??null,
      serverMovementEffectiveSpeed:lastServerMovementAttribute?.effective??null,
      serverMovementModifiers:lastServerMovementAttribute?.modifiers??'none',
      serverMovementSprintModifier:lastServerMovementAttribute?.sprintModifier??null,
      sinceVelocityPacketMs:lastBotVelocityAt?now-lastBotVelocityAt:null,
      serverVelocityX:lastBotVelocity?.x??null,
      serverVelocityY:lastBotVelocity?.y??null,
      serverVelocityZ:lastBotVelocity?.z??null,
      horizontal: Math.round(horizontal*1000)/1000,
      vertical: Math.round(vertical*1000)/1000,
      relativeX: relative.x, relativeY: relative.y, relativeZ: relative.z,
      feetBlock: feetBlock?.name ?? null,
      feetMeta: typeof feetBlock?.metadata === 'number' ? feetBlock.metadata : null,
      floorBlock: floorBlock?.name ?? null,
      floorMeta: typeof floorBlock?.metadata === 'number' ? floorBlock.metadata : null,
      beforeSupport,
      targetSupport,
      beforeX: Math.round(before.x*1000)/1000,
      beforeY: Math.round(before.y*1000)/1000,
      beforeZ: Math.round(before.z*1000)/1000,
      targetX: Math.round(target.x*1000)/1000,
      targetY: Math.round(target.y*1000)/1000,
      targetZ: Math.round(target.z*1000)/1000,
      velocityX: Math.round(bot.entity.velocity.x*1000)/1000,
      velocityY: Math.round(bot.entity.velocity.y*1000)/1000,
      velocityZ: Math.round(bot.entity.velocity.z*1000)/1000,
      walkingSpeed: typeof runtimeBot.abilities?.walkingSpeed === 'number' ? runtimeBot.abilities.walkingSpeed : null,
      movementAttributeKey: movementEntry?.[0] ?? null,
      movementAttributeValue: typeof movementAttribute?.value === 'number' ? movementAttribute.value : null,
      movementModifierCount: modifiers.length,
      movementModifiers: modifierSummary || 'none',
      effectiveMovementSpeed: typeof effectiveMovementSpeed === 'number' ? effectiveMovementSpeed : null,
      effects: effectSummary || 'none',
      forward: bot.getControlState('forward'),
      jump: bot.getControlState('jump'),
      sprint: bot.getControlState('sprint'),
      onGround: Boolean(bot.entity.onGround)
    });
  };
  const abilitiesPacket = (packet:{flags:number;flyingSpeed:number;walkingSpeed:number}) => {
    if(closed)return;
    lastServerAbilitiesAt=Date.now();
    lastServerAbilities={flags:packet.flags,flyingSpeed:packet.flyingSpeed,walkingSpeed:packet.walkingSpeed};
  };
  bot._client.prependListener('abilities', abilitiesPacket);
  const updateAttributesPacket = (packet:{
    entityId:number;
    properties:Array<{key:string;value:number;modifiers:Array<{uuid:unknown;amount:number;operation:number}>}>;
  }) => {
    if(closed || packet.entityId!==bot.entity?.id)return;
    const property=packet.properties?.find(value=>/movement.*speed|speed.*movement/i.test(value.key));
    if(!property)return;
    const modifiers=Array.isArray(property.modifiers)?property.modifiers:[];
    const sprintUuid='662a6b8d-da3e-4c1c-8813-96ea6097278d';
    const uuidString=(value:unknown)=>typeof value==='string'?value.toLowerCase():String(value).toLowerCase();
    const sprintModifier=modifiers.some(modifier=>uuidString(modifier.uuid)===sprintUuid);
    const summary=modifiers.map(modifier=>`${Math.round(modifier.amount*10000)/10000}:${modifier.operation}:${uuidString(modifier.uuid).slice(0,8)}`).slice(0,8).join(',');
    const baseAfterAdd=property.value+modifiers.filter(modifier=>modifier.operation===0).reduce((sum,modifier)=>sum+modifier.amount,0);
    let effective=baseAfterAdd;
    effective+=baseAfterAdd*modifiers.filter(modifier=>modifier.operation===1).reduce((sum,modifier)=>sum+modifier.amount,0);
    for(const modifier of modifiers)if(modifier.operation===2)effective+=effective*modifier.amount;
    lastServerMovementAttributeAt=Date.now();
    lastServerMovementAttribute={
      value:property.value,effective,modifiers:summary||'none',sprintModifier,
      x:bot.entity?.position?.x??null,y:bot.entity?.position?.y??null,z:bot.entity?.position?.z??null
    };
  };
  bot._client.prependListener('update_attributes', updateAttributesPacket);
  bot._client.prependListener('entity_update_attributes', updateAttributesPacket);
  const runtimeClient = bot._client as unknown as { write(name:string, params:Record<string, unknown>): unknown };
  const originalClientWrite = runtimeClient.write.bind(bot._client);
  runtimeClient.write = (name:string, params:Record<string, unknown>) => {
    const isMovementPacket=['position','position_look','look','flying'].includes(name);
    const isCorrectionAck=isMovementPacket&&correctionAckPending>0&&name==='position_look';
    let wireName=name;
    let wireParams=params;
    if(config.version==='1.8.9' && (name==='position_look'||name==='look') && typeof params.yaw==='number' && Number.isFinite(params.yaw)){
      let wireYaw=params.yaw;
      if(isCorrectionAck && pendingCorrectionAckYaw!==undefined){
        wireYaw=pendingCorrectionAckYaw;
        pendingCorrectionAckYaw=undefined;
      }else if(lastWireYaw!==undefined){
        while(wireYaw-lastWireYaw>180)wireYaw-=360;
        while(wireYaw-lastWireYaw<-180)wireYaw+=360;
      }
      lastWireYaw=wireYaw;
      if(wireYaw!==params.yaw)wireParams={...params,yaw:wireYaw};
    }

    // Vanilla 1.8.9 does not include position in every movement packet.
    // EntityPlayerSP only reports coordinates when the squared delta from the
    // last reported position exceeds 9e-4, or after 20 position-update ticks.
    // Mineflayer 4.39 otherwise emits position for any non-zero coordinate
    // change, which produces a different legacy packet stream than Forge/Vanilla.
    if(config.version==='1.8.9' && isMovementPacket && !isCorrectionAck){
      const current=bot.entity?.position;
      const hasLook=wireName==='look'||wireName==='position_look';
      const hasPosition=wireName==='position'||wireName==='position_look';
      const x=hasPosition&&typeof wireParams.x==='number'&&Number.isFinite(wireParams.x) ? wireParams.x : current?.x;
      const y=hasPosition&&typeof wireParams.y==='number'&&Number.isFinite(wireParams.y) ? wireParams.y : current?.y;
      const z=hasPosition&&typeof wireParams.z==='number'&&Number.isFinite(wireParams.z) ? wireParams.z : current?.z;

      if(x!==undefined&&y!==undefined&&z!==undefined){
        if(!legacyReportedPosition){
          if(hasPosition){
            legacyReportedPosition={x,y,z};
            legacyPositionUpdateTicks=0;
          }else{
            legacyPositionUpdateTicks++;
          }
        }else{
          const dx=x-legacyReportedPosition.x;
          const dy=y-legacyReportedPosition.y;
          const dz=z-legacyReportedPosition.z;
          const positionUpdated=dx*dx+dy*dy+dz*dz>9.0e-4 || legacyPositionUpdateTicks>=20;

          if(positionUpdated){
            if(!hasPosition){
              wireName=hasLook?'position_look':'position';
              wireParams=hasLook
                ? {x,y,z,yaw:wireParams.yaw,pitch:wireParams.pitch,onGround:wireParams.onGround}
                : {x,y,z,onGround:wireParams.onGround};
            }
            legacyReportedPosition={x,y,z};
            legacyPositionUpdateTicks=0;
          }else{
            if(hasPosition){
              wireName=hasLook?'look':'flying';
              wireParams=hasLook
                ? {yaw:wireParams.yaw,pitch:wireParams.pitch,onGround:wireParams.onGround}
                : {onGround:wireParams.onGround};
            }
            legacyPositionUpdateTicks++;
          }
        }
      }
    }

    if(isCorrectionAck)correctionAckPending--;
    if(!closed && isMovementPacket && !isCorrectionAck){
      const now=Date.now();
      movementPacketTimes.push(now);
      while(movementPacketTimes.length>48||movementPacketTimes[0]!<now-2000)movementPacketTimes.shift();
      if((wireName==='position'||wireName==='position_look') &&
          typeof wireParams.x==='number'&&Number.isFinite(wireParams.x)&&
          typeof wireParams.y==='number'&&Number.isFinite(wireParams.y)&&
          typeof wireParams.z==='number'&&Number.isFinite(wireParams.z)){
        movementHistory.push({
          at:now,packet:wireName,x:wireParams.x,y:wireParams.y,z:wireParams.z,
          yaw:typeof wireParams.yaw==='number'&&Number.isFinite(wireParams.yaw)?wireParams.yaw:null,
          onGround:typeof wireParams.onGround==='boolean'?wireParams.onGround:null
        });
        while(movementHistory.length>80||movementHistory[0]!.at<now-4000)movementHistory.shift();
      }
    }
    if(!closed && name==='entity_action' && (params.actionId===3||params.actionId===4)){
      const now=Date.now();
      sprintActionTimes.push(now);
      lastSprintActionAt=now;
      lastSprintAction=params.actionId===3?'START':'STOP';
      while(sprintActionTimes.length>16||sprintActionTimes[0]!<now-4000)sprintActionTimes.shift();
    }
    if (!closed && correctionTraceRemaining > 0 && Date.now() <= correctionTraceUntil &&
        ['position','position_look','look','flying','teleport_confirm'].includes(name)) {
      correctionTraceRemaining--;
      const numeric = (value:unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value*1000)/1000 : null;
      events.diagnostic?.('movement packet after correction', {
        packet:wireName,
        x:numeric(wireParams.x), y:numeric(wireParams.y), z:numeric(wireParams.z),
        yaw:numeric(wireParams.yaw), pitch:numeric(wireParams.pitch),
        onGround:typeof wireParams.onGround === 'boolean' ? wireParams.onGround : null,
        teleportId:typeof wireParams.teleportId === 'number' ? wireParams.teleportId : null,
        correctionAck:isCorrectionAck,
        correctionSequence,
        sinceCorrectionMs:lastCorrectionAt?Date.now()-lastCorrectionAt:null
      });
    }
    return originalClientWrite(wireName,wireParams);
  };
  const velocityPacket = (packet:{entityId:number;velocity:{x:number;y:number;z:number}}) => {
    if(closed||packet.entityId!==bot.entity?.id)return;
    const now=Date.now();
    const beforeVelocity={x:bot.entity.velocity.x,y:bot.entity.velocity.y,z:bot.entity.velocity.z};
    lastBotVelocityAt=now;
    lastBotVelocity={x:packet.velocity.x/8000,y:packet.velocity.y/8000,z:packet.velocity.z/8000};
    if(now<=correctionTraceUntil){
      events.diagnostic?.('velocity packet after correction',{
        correctionSequence,
        sinceCorrectionMs:lastCorrectionAt?now-lastCorrectionAt:null,
        beforeVelocityX:Math.round(beforeVelocity.x*1000)/1000,
        beforeVelocityY:Math.round(beforeVelocity.y*1000)/1000,
        beforeVelocityZ:Math.round(beforeVelocity.z*1000)/1000,
        serverVelocityX:Math.round(lastBotVelocity.x*1000)/1000,
        serverVelocityY:Math.round(lastBotVelocity.y*1000)/1000,
        serverVelocityZ:Math.round(lastBotVelocity.z*1000)/1000
      });
    }
  };
  const physicsTickTrace = () => {
    const now=Date.now();
    if(closed||now>correctionTraceUntil||!bot.entity)return;
    events.diagnostic?.('physics tick after correction',{
      correctionSequence,
      sinceCorrectionMs:lastCorrectionAt?now-lastCorrectionAt:null,
      x:Math.round(bot.entity.position.x*1000)/1000,
      y:Math.round(bot.entity.position.y*1000)/1000,
      z:Math.round(bot.entity.position.z*1000)/1000,
      velocityX:Math.round(bot.entity.velocity.x*1000)/1000,
      velocityY:Math.round(bot.entity.velocity.y*1000)/1000,
      velocityZ:Math.round(bot.entity.velocity.z*1000)/1000,
      forward:bot.getControlState('forward'),
      jump:bot.getControlState('jump'),
      sprint:bot.getControlState('sprint'),
      onGround:Boolean(bot.entity.onGround)
    });
  };
  bot._client.prependListener('entity_velocity', velocityPacket);
  bot._client.prependListener('position', positionPacket);
  bot.on('physicsTick', physicsTickTrace);
  bot.on('login', reportIdentity); bot.on('spawn', spawn); bot.on('respawn', reset); bot.on('messagestr', message);
  bot.on('entitySpawn', entitySpawn); bot.on('blockUpdate', blockUpdate);
  bot.on('kicked', kicked); bot.on('end', end); bot.on('error', error);
  if (config.level === 'debug') { bot.on('windowOpen', windowOpen); bot.on('windowClose', windowClose); }
  return {
    position: () => bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : undefined,
    ping: () => { const ping = bot.player?.ping; return typeof ping === 'number' && Number.isFinite(ping) && ping > 0 ? ping : undefined; },
    chat: command => { if (closed) throw new Error('Transport closed'); bot.chat(command); },
    navigate: async (target, signal) => {
      const abort = () => stopPath();
      signal.addEventListener('abort', abort, { once: true });
      try {
        await waitUntilGrounded(signal);
        await controlWalk(target,1,signal);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    launchToward: async (target, signal, completion = 'LANDING') => {
      signal.throwIfAborted();
      const start = bot.entity?.position;
      if (!start) throw new Error('Launch position unavailable');
      const slime = bot.findBlocks({ matching: block => block.name === 'slime' || block.name === 'slime_block', maxDistance: 32, count: 96 })
        .filter(pos => Math.abs(pos.y - start.y) <= 6);
      if (!slime.length) throw new Error('Launch pad not found');

      const remaining = [...slime], clusters: Array<typeof slime> = [];
      while (remaining.length) {
        const seed = remaining.pop()!, cluster = [seed];
        for (let changed = true; changed;) {
          changed = false;
          for (let i = remaining.length - 1; i >= 0; i--) {
            if (cluster.some(p => Math.abs(p.x - remaining[i]!.x) <= 1 && Math.abs(p.y - remaining[i]!.y) <= 1 && Math.abs(p.z - remaining[i]!.z) <= 1)) {
              cluster.push(remaining.splice(i, 1)[0]!); changed = true;
            }
          }
        }
        if (cluster.length >= 4) clusters.push(cluster);
      }
      if (!clusters.length) throw new Error('Launch pad not found');

      const centers = clusters.map(cluster => ({
        x: cluster.reduce((sum,p)=>sum+p.x,0)/cluster.length + .5,
        y: Math.max(...cluster.map(p=>p.y)) + 1,
        z: cluster.reduce((sum,p)=>sum+p.z,0)/cluster.length + .5,
        blocks: cluster.length
      }));
      const tx = target.x - start.x, tz = target.z - start.z, targetLength = Math.hypot(tx,tz) || 1;
      centers.sort((a,b) => {
        const score = (p: typeof a) => {
          const px=p.x-start.x,pz=p.z-start.z,length=Math.hypot(px,pz)||1;
          return (px*tx+pz*tz)/(length*targetLength);
        };
        return score(b)-score(a);
      });
      const pad = centers[0]!;
      events.diagnostic?.('launch pad selected', { candidates: centers.length, blocks: pad.blocks,
        padX: Math.round(pad.x*10)/10, padY: Math.round(pad.y*10)/10, padZ: Math.round(pad.z*10)/10 });

      const dx=pad.x-start.x,dz=pad.z-start.z,distance=Math.hypot(dx,dz)||1;
      const approach={x:pad.x-dx/distance*2.2,y:pad.y,z:pad.z-dz/distance*2.2};
      const abort = () => stopPath();
      signal.addEventListener('abort', abort, { once:true });
      try {
        await controlWalk(approach,0.8,signal);
        signal.throwIfAborted();
        const padBlock = bot.blockAt(slime.reduce((best,p)=>Math.hypot(p.x-pad.x,p.z-pad.z)<Math.hypot(best.x-pad.x,best.z-pad.z)?p:best,slime[0]!));
        if (!padBlock) throw new Error('Launch pad unavailable');
        await turnToward({x:padBlock.position.x+.5,y:padBlock.position.y+1,z:padBlock.position.z+.5},signal);
        signal.throwIfAborted();
        bot.clearControlStates();
        bot.setControlState('sprint',false);
        bot.setControlState('forward',true);
        const launchedFrom={x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z};
        let launched=false, groundSamples=0;
        await new Promise<void>((resolve,reject)=>{
          const started=Date.now();
          const onAbort=()=>{clearInterval(timer);reject(new Error('Launch cancelled'));};
          const timer=setInterval(()=>{
            if(signal.aborted){onAbort();return;}
            const entity=bot.entity,p=entity?.position;
            if(!p)return;
            const horizontal=Math.hypot(p.x-launchedFrom.x,p.z-launchedFrom.z);
            if(!launched&&(horizontal>7||Math.abs(p.y-launchedFrom.y)>4)){
              launched=true;bot.setControlState('forward',false);
              if(completion==='LAUNCH'){clearInterval(timer);signal.removeEventListener('abort',onAbort);resolve();return;}
            }
            if(launched){groundSamples=(entity as {onGround?:boolean}).onGround?groundSamples+1:0;if(groundSamples>=2&&horizontal>7){clearInterval(timer);signal.removeEventListener('abort',onAbort);resolve();return;}}
            if(Date.now()-started>10_000){clearInterval(timer);signal.removeEventListener('abort',onAbort);reject(new Error(launched?'Launch landing timeout':'Launch pad did not trigger'));}
          },50);
          signal.addEventListener('abort',onAbort,{once:true});
        });
      } finally {
        bot.clearControlStates(); signal.removeEventListener('abort',abort);
      }
    },
    stopPath,
    close: () => {
      if (closed) return; closed = true;
      stopPath();
      bot._client.removeListener('entity_velocity', velocityPacket);
      bot._client.removeListener('position', positionPacket);
      bot._client.removeListener('abilities', abilitiesPacket);
      bot._client.removeListener('update_attributes', updateAttributesPacket);
      bot._client.removeListener('entity_update_attributes', updateAttributesPacket);
      bot.removeListener('physicsTick', physicsTickTrace);
      runtimeClient.write = originalClientWrite;
      bot.removeListener('login', reportIdentity); bot.removeListener('spawn', spawn); bot.removeListener('respawn', reset); bot.removeListener('messagestr', message);
      bot.removeListener('entitySpawn', entitySpawn); bot.removeListener('blockUpdate', blockUpdate);
      bot.removeListener('kicked', kicked); bot.removeListener('end', end); bot.removeListener('windowOpen', windowOpen); bot.removeListener('windowClose', windowClose);
      try { (bot as ViewerBot).viewer?.close(); } catch { /* Viewer shutdown must not block bot shutdown. */ }
      viewerStarted = false;
      // Keep the guarded error listener until transport GC to absorb late socket errors.
      bot.end('BBot stopped');
    }
  };
}

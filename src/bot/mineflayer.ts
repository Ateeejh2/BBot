import { createBot, type BotOptions } from 'mineflayer';
import pathfinderModule from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderModule;
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parseInstance } from '../instances/parser.js';
import { eligibleTransferChannel } from './message-source.js';
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
  const common = { host: config.host, port: config.port, version: config.version, hideErrors: true, logErrors: false };
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
  const stopPath = () => { bot.clearControlStates(); };
  const walkingMovements = () => {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.allowSprinting = false;
    movements.scafoldingBlocks = [];
    movements.allowFreeMotion = false;
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
    const movements = walkingMovements();
    const plan = bot.pathfinder.getPathTo(movements, new goals.GoalNear(target.x,target.y,target.z,range), config.pathTimeoutMs);
    if (plan.status !== 'success') throw new Error(plan.status === 'noPath' ? 'No path to the goal!' : 'Path planning timeout');
    events.diagnostic?.('control path planned',{nodes:plan.path.length,targetX:target.x,targetY:target.y,targetZ:target.z});
    const started = Date.now();
    try {
      bot.setControlState('sprint',false);
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
          if (horizontal <= 0.42 && Math.abs(dy) < 1.05) break;
          if (horizontal < best-0.03) { best=horizontal; lastProgress=Date.now(); }
          else if (Date.now()-lastProgress > 3000) throw new Error('Control walk stuck');

          const yaw = Math.atan2(-dx,-dz);
          const turn = angleDelta(yaw,bot.entity.yaw);
          if (Math.abs(turn) > 0.04) {
            const step = Math.max(-0.12,Math.min(0.12,turn));
            if (Math.abs(turn) > 0.6) bot.setControlState('forward',false);
            void bot.look(bot.entity.yaw+step,bot.entity.pitch,false);
          }
          signal.throwIfAborted();
          const aligned = Math.abs(angleDelta(yaw,bot.entity.yaw)) <= 0.55;
          bot.setControlState('sprint',false);
          bot.setControlState('sneak',false);
          bot.setControlState('back',false);
          bot.setControlState('left',false);
          bot.setControlState('right',false);
          bot.setControlState('forward',aligned);
          bot.setControlState('jump',aligned && dy > 0.35 && bot.entity.onGround);
          await bot.waitForTicks(1);
        }
        bot.setControlState('jump',false);
      }
      const p = bot.entity?.position;
      if (!p || Math.hypot(p.x-target.x,p.z-target.z) > range+0.9 || Math.abs(p.y-target.y) > 1.5) throw new Error('Control walk ended before arrival');
    } finally {
      bot.clearControlStates();
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
    const lower = clean.toLowerCase();
    const candidate = parseInstance(text);
    const eligible = eligibleTransferChannel(position, sender, config.transferMessageChannel, candidate !== undefined);
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
    if (!eligible) return;
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
  const positionPacket = (packet: { x:number; y:number; z:number; flags:number | {x?:boolean;y?:boolean;z?:boolean} }) => {
    if (closed || !bot.entity?.position) return;
    correctionTraceUntil = Date.now() + 200;
    correctionTraceRemaining = 4;
    const before = bot.entity.position;
    const relative = typeof packet.flags === 'object'
      ? { x:Boolean(packet.flags.x), y:Boolean(packet.flags.y), z:Boolean(packet.flags.z) }
      : { x:Boolean(packet.flags & 1), y:Boolean(packet.flags & 2), z:Boolean(packet.flags & 4) };
    const target = {
      x: relative.x ? before.x + packet.x : packet.x,
      y: relative.y ? before.y + packet.y : packet.y,
      z: relative.z ? before.z + packet.z : packet.z
    };
    const horizontal = Math.hypot(target.x-before.x,target.z-before.z);
    const vertical = target.y-before.y;
    const feetBlock = bot.blockAt(before);
    const floorBlock = bot.blockAt(before.offset(0,-0.01,0));
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
    events.diagnostic?.('server position correction', {
      sinceSpawnMs: lastSpawnAt ? Date.now()-lastSpawnAt : null,
      horizontal: Math.round(horizontal*1000)/1000,
      vertical: Math.round(vertical*1000)/1000,
      relativeX: relative.x, relativeY: relative.y, relativeZ: relative.z,
      feetBlock: feetBlock?.name ?? null,
      feetMeta: typeof feetBlock?.metadata === 'number' ? feetBlock.metadata : null,
      floorBlock: floorBlock?.name ?? null,
      floorMeta: typeof floorBlock?.metadata === 'number' ? floorBlock.metadata : null,
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
  const runtimeClient = bot._client as unknown as { write(name:string, params:Record<string, unknown>): unknown };
  const originalClientWrite = runtimeClient.write.bind(bot._client);
  runtimeClient.write = (name:string, params:Record<string, unknown>) => {
    if (!closed && correctionTraceRemaining > 0 && Date.now() <= correctionTraceUntil &&
        ['position','position_look','look','flying','teleport_confirm'].includes(name)) {
      correctionTraceRemaining--;
      const numeric = (value:unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value*1000)/1000 : null;
      events.diagnostic?.('movement packet after correction', {
        packet:name,
        x:numeric(params.x), y:numeric(params.y), z:numeric(params.z),
        yaw:numeric(params.yaw), pitch:numeric(params.pitch),
        onGround:typeof params.onGround === 'boolean' ? params.onGround : null,
        teleportId:typeof params.teleportId === 'number' ? params.teleportId : null
      });
    }
    return originalClientWrite(name,params);
  };
  bot._client.prependListener('position', positionPacket);
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
        await controlWalk(target,1,signal);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    launchToward: async (target, signal) => {
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
            if(!launched&&(horizontal>7||Math.abs(p.y-launchedFrom.y)>4)){launched=true;bot.setControlState('forward',false);}
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
      bot._client.removeListener('position', positionPacket);
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

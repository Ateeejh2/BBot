import net from 'node:net';
import { createRequire } from 'node:module';
import type { Config } from '../config/index.js';
import type { Position } from '../core/types.js';
import { parseInstance } from '../instances/parser.js';
import { parseCarePackageAnnouncement } from '../events/care-package.js';
import { sharedPitNavigation, type PitChunkData } from '../pathfinding/pit-navigation.js';
import { eligibleServerAnnouncementChannel, eligibleTransferChannel, isDeathNotice, isLimboNotice } from './message-source.js';
import type { BotTransport, TransportEvents } from './transport.js';

interface BridgeState {
  type: 'state';
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
  sprinting: boolean;
  collidedH: boolean;
  allowFlying: boolean;
  flying: boolean;
  phase: string;
  bridgeControl: boolean;
  pingMs?: number;
}

interface BridgeEvent {
  type: 'event';
  event: string;
  text?: string;
  channel?: string;
  username?: string;
  x?: number;
  y?: number;
  z?: number;
  stateId?: number;
}

interface BridgeResponse {
  type: 'response';
  requestId: string;
  kind?: string;
  ok: boolean;
  error?: string;
  blocks?: Array<{ x?: unknown; y?: unknown; z?: unknown }>;
  chunks?: Array<{ x?: unknown; z?: unknown }>;
  chunkX?: number;
  chunkZ?: number;
  sections?: Array<{ y?: unknown; states?: unknown }>;
}

type BridgeMessage =
  | BridgeState
  | BridgeEvent
  | BridgeResponse
  | { type: 'bridge'; event: string; protocol?: number };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseState(value: unknown): BridgeState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Partial<BridgeState>;
  if (state.type !== 'state' ||
      !isFiniteNumber(state.tick) ||
      !isFiniteNumber(state.x) || !isFiniteNumber(state.y) || !isFiniteNumber(state.z) ||
      !isFiniteNumber(state.yaw) || !isFiniteNumber(state.pitch) ||
      typeof state.onGround !== 'boolean' ||
      typeof state.sprinting !== 'boolean' ||
      typeof state.collidedH !== 'boolean' ||
      typeof state.allowFlying !== 'boolean' ||
      typeof state.flying !== 'boolean' ||
      typeof state.phase !== 'string' ||
      typeof state.bridgeControl !== 'boolean' ||
      (state.pingMs !== undefined && (!isFiniteNumber(state.pingMs) || state.pingMs < 0))) return undefined;
  return state as BridgeState;
}

function yawToward(from: Position, target: Position): number {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  return Math.atan2(-dx, dz) * 180 / Math.PI;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Movement cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createForgeTransport(config: Config, index: number, events: TransportEvents): BotTransport {
  const port = config.forge.bridgeBasePort + index;
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setEncoding('utf8');
  socket.setNoDelay(true);

  let closed = false;
  let ended = false;
  let buffer = '';
  let current: BridgeState | undefined;
  let connected = false;
  let requestSequence = 0;
  let boundInstanceId: string | undefined;
  let viewerClose: (() => void) | undefined;
  let viewerState: ((state: BridgeState) => void) | undefined;
  let viewerBlockUpdate: ((x: number, y: number, z: number, stateId: number) => void) | undefined;
  let viewerReset: (() => void) | undefined;
  const pending = new Map<string, {
    resolve: (response: BridgeResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
  }>();

  const emitEnd = () => {
    if (ended || closed) return;
    ended = true;
    events.end();
  };

  const send = (message: Record<string, unknown>) => {
    if (closed || !connected || socket.destroyed || !socket.writable) throw new Error('Transport closed');
    socket.write(JSON.stringify(message) + '\n');
  };

  const release = () => {
    if (closed || !connected || socket.destroyed || !socket.writable) return;
    socket.write('{"type":"release"}\n');
  };

  const settlePending = (requestId: string, response?: BridgeResponse, error?: Error) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    if (error) entry.reject(error);
    else if (response) entry.resolve(response);
  };

  const failPending = (message: string) => {
    for (const requestId of [...pending.keys()]) settlePending(requestId, undefined, new Error(message));
  };

  const request = (message: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 3000): Promise<BridgeResponse> => {
    signal?.throwIfAborted();
    const requestId = `${index + 1}-${++requestSequence}`;
    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => settlePending(requestId, undefined, new Error('Forge bridge request timeout')), timeoutMs);
      const abort = signal ? () => settlePending(requestId, undefined,
        signal.reason instanceof Error ? signal.reason : new Error('Movement cancelled')) : undefined;
      pending.set(requestId, { resolve, reject, timer, signal, abort });
      if (signal && abort) signal.addEventListener('abort', abort, { once: true });
      try {
        send({ ...message, requestId });
      } catch (error) {
        settlePending(requestId, undefined, error instanceof Error ? error : new Error('Forge bridge request failed'));
      }
    });
  };

  const waitForBridge = (timeoutMs = 5000): Promise<void> => {
    if (connected && !socket.destroyed && socket.writable) return Promise.resolve();
    if (closed) return Promise.reject(new Error('Transport closed'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Forge bridge connection timeout')), timeoutMs);
      const onConnect = () => finish();
      const onClose = () => finish(new Error('Forge bridge disconnected'));
      const onError = () => finish(new Error('Forge bridge connection failed'));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('close', onClose);
        socket.off('error', onError);
        if (error) reject(error); else resolve();
      };
      socket.once('connect', onConnect);
      socket.once('close', onClose);
      socket.once('error', onError);
    });
  };

  const connectServer = async (host: string, serverPort: number): Promise<void> => {
    await waitForBridge();
    const response = await request({ type: 'connectServer', host, port: serverPort }, undefined, 5000);
    if (!response.ok || response.kind !== 'serverControl') {
      throw new Error(response.error === 'ALREADY_CONNECTED' ? 'ALREADY_CONNECTED' : 'SERVER_CONNECT_FAILED');
    }
  };

  const disconnectServer = async (): Promise<void> => {
    await waitForBridge();
    const response = await request({ type: 'disconnectServer' }, undefined, 5000);
    if (!response.ok || response.kind !== 'serverControl') {
      throw new Error(response.error === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'SERVER_DISCONNECT_FAILED');
    }
  };

  const listLoadedPitChunks = async (signal:AbortSignal):Promise<Array<{x:number;z:number}>> => {
    const response=await request({type:'getLoadedChunks'},signal,5000);
    if(!response.ok||response.kind!=='loadedChunks'||!Array.isArray(response.chunks))return [];
    return response.chunks.flatMap(value=>
      isFiniteNumber(value.x)&&isFiniteNumber(value.z)?[{x:value.x,z:value.z}]:[]
    );
  };

  const loadPitChunk = async (chunkX:number, chunkZ:number, signal:AbortSignal):Promise<PitChunkData|undefined> => {
    const response=await request({type:'getChunk',chunkX,chunkZ},signal,5000);
    if(!response.ok||response.kind!=='chunk'||!Array.isArray(response.sections))return;
    const sections:PitChunkData['sections']=[];
    for(const section of response.sections){
      if(!Number.isSafeInteger(section.y)||typeof section.states!=='string')continue;
      const y=section.y as number;
      if(y<0||y>15)continue;
      const raw=Buffer.from(section.states,'base64');
      if(raw.length!==8192)continue;
      const states=new Uint16Array(4096);
      for(let i=0;i<4096;i++)states[i]=raw.readUInt16LE(i*2);
      sections.push({y,states});
    }
    return {chunkX,chunkZ,sections};
  };

  const startForgeViewer = () => {
    const botId = `bot-${index + 1}`;
    if (!config.viewer.enabled || config.viewer.botId !== botId || viewerClose) return;

    try {
      const localRequire = createRequire(import.meta.url);
      const viewerRequire = createRequire(localRequire.resolve('prismarine-viewer/package.json'));
      const express = viewerRequire('express') as any;
      const http = viewerRequire('http') as typeof import('node:http');
      const socketIo = viewerRequire('socket.io') as any;
      const { setupRoutes } = viewerRequire('./lib/common') as { setupRoutes(app: any, prefix?: string): void };
      const Chunk = viewerRequire('prismarine-chunk')('1.8.8') as any;
      const Vec3 = viewerRequire('vec3').Vec3 as new (x: number, y: number, z: number) => any;

      const app = express();
      const server = http.createServer(app);
      const io = socketIo(server);
      setupRoutes(app, '');

      const sockets = new Set<any>();
      const loaded = new Map<any, Set<string>>();
      const centers = new Map<any, string>();
      const chunkCache = new Map<string, any>();
      const loading = new Map<string, Promise<any | undefined>>();
      let stopped = false;

      const keyOf = (chunkX: number, chunkZ: number) => `${chunkX},${chunkZ}`;
      const parseKey = (key: string) => {
        const [x, z] = key.split(',').map(Number);
        return { x: x!, z: z! };
      };

      const loadChunk = async (chunkX: number, chunkZ: number): Promise<any | undefined> => {
        const key = keyOf(chunkX, chunkZ);
        const cached = chunkCache.get(key);
        if (cached) return cached;
        const existing = loading.get(key);
        if (existing) return existing;

        const task = (async () => {
          const response = await request({ type: 'getChunk', chunkX, chunkZ }, undefined, 5000);
          if (!response.ok || response.kind !== 'chunk' || !Array.isArray(response.sections)) return undefined;

          const chunk = new Chunk();
          for (let y = 0; y < 256; y++) {
            for (let z = 0; z < 16; z++) {
              for (let x = 0; x < 16; x++) chunk.setSkyLight(new Vec3(x, y, z), 15);
            }
          }

          for (const section of response.sections) {
            if (!Number.isSafeInteger(section.y) || typeof section.states !== 'string') continue;
            const sectionY = section.y as number;
            if (sectionY < 0 || sectionY > 15) continue;
            const raw = Buffer.from(section.states, 'base64');
            if (raw.length !== 8192) continue;
            let offset = 0;
            for (let y = 0; y < 16; y++) {
              for (let z = 0; z < 16; z++) {
                for (let x = 0; x < 16; x++) {
                  const stateId = raw[offset]! | (raw[offset + 1]! << 8);
                  offset += 2;
                  if (stateId !== 0) chunk.setBlockStateId(new Vec3(x, sectionY * 16 + y, z), stateId);
                }
              }
            }
          }

          chunkCache.set(key, chunk);
          return chunk;
        })().catch(error => {
          events.diagnostic?.('viewer chunk load failed', {
            chunkX,
            chunkZ,
            reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown'
          });
          return undefined;
        }).finally(() => loading.delete(key));

        loading.set(key, task);
        return task;
      };

      const refresh = async (socket: any, state: BridgeState) => {
        if (stopped || !sockets.has(socket)) return;
        const centerX = Math.floor(state.x / 16);
        const centerZ = Math.floor(state.z / 16);
        const desired = new Set<string>();
        for (let x = centerX - config.viewer.viewDistance; x <= centerX + config.viewer.viewDistance; x++) {
          for (let z = centerZ - config.viewer.viewDistance; z <= centerZ + config.viewer.viewDistance; z++) {
            desired.add(keyOf(x, z));
          }
        }

        const present = loaded.get(socket) ?? new Set<string>();
        loaded.set(socket, present);
        for (const key of [...present]) {
          if (desired.has(key)) continue;
          present.delete(key);
          const { x, z } = parseKey(key);
          socket.emit('unloadChunk', { x: x * 16, z: z * 16 });
        }

        const ordered = [...desired].sort((a, b) => {
          const aa = parseKey(a), bb = parseKey(b);
          return Math.hypot(aa.x - centerX, aa.z - centerZ) - Math.hypot(bb.x - centerX, bb.z - centerZ);
        });

        for (const key of ordered) {
          if (stopped || !sockets.has(socket)) return;
          if (present.has(key)) continue;
          const { x, z } = parseKey(key);
          const chunk = await loadChunk(x, z);
          if (!chunk || stopped || !sockets.has(socket)) continue;
          present.add(key);
          socket.emit('loadChunk', { x: x * 16, z: z * 16, chunk: chunk.toJson() });
          await new Promise(resolve => setImmediate(resolve));
        }
      };

      io.on('connection', (socket: any) => {
        sockets.add(socket);
        loaded.set(socket, new Set<string>());
        socket.emit('version', '1.8.8');
        if (current) {
          const packet: Record<string, unknown> = {
            pos: { x: current.x, y: current.y, z: current.z },
            yaw: current.yaw * Math.PI / 180,
            addMesh: true
          };
          if (config.viewer.firstPerson) packet.pitch = current.pitch * Math.PI / 180;
          socket.emit('position', packet);
          centers.set(socket, keyOf(Math.floor(current.x / 16), Math.floor(current.z / 16)));
          void refresh(socket, current);
        }
        socket.on('disconnect', () => {
          sockets.delete(socket);
          loaded.delete(socket);
          centers.delete(socket);
        });
      });

      viewerState = state => {
        for (const socket of sockets) {
          const packet: Record<string, unknown> = {
            pos: { x: state.x, y: state.y, z: state.z },
            yaw: state.yaw * Math.PI / 180,
            addMesh: true
          };
          if (config.viewer.firstPerson) packet.pitch = state.pitch * Math.PI / 180;
          socket.emit('position', packet);

          const centerKey = keyOf(Math.floor(state.x / 16), Math.floor(state.z / 16));
          if (centers.get(socket) !== centerKey) {
            centers.set(socket, centerKey);
            void refresh(socket, state);
          }
        }
      };

      viewerBlockUpdate = (x, y, z, stateId) => {
        const key = keyOf(Math.floor(x / 16), Math.floor(z / 16));
        const chunk = chunkCache.get(key);
        if (chunk && y >= 0 && y < 256) {
          chunk.setBlockStateId(new Vec3(x & 15, y, z & 15), stateId);
        }
        for (const socket of sockets) {
          if (loaded.get(socket)?.has(key)) socket.emit('blockUpdate', { pos: { x, y, z }, stateId });
        }
      };

      viewerReset = () => {
        chunkCache.clear();
        loading.clear();
        for (const socket of sockets) {
          for (const key of loaded.get(socket) ?? []) {
            const { x, z } = parseKey(key);
            socket.emit('unloadChunk', { x: x * 16, z: z * 16 });
          }
          loaded.set(socket, new Set<string>());
          centers.delete(socket);
        }
      };

      server.listen(config.viewer.port, '127.0.0.1', () => {
        events.diagnostic?.('viewer started', {
          botId,
          port: config.viewer.port,
          firstPerson: config.viewer.firstPerson,
          viewDistance: config.viewer.viewDistance,
          source: 'forge'
        });
      });
      server.on('error', error => {
        events.diagnostic?.('viewer start failed', {
          botId,
          port: config.viewer.port,
          reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
        });
      });

      viewerClose = () => {
        if (stopped) return;
        stopped = true;
        viewerState = undefined;
        viewerBlockUpdate = undefined;
        viewerReset = undefined;
        for (const socket of sockets) socket.disconnect(true);
        sockets.clear();
        loaded.clear();
        centers.clear();
        chunkCache.clear();
        io.close();
        server.close();
      };
    } catch (error) {
      events.diagnostic?.('viewer start failed', {
        botId,
        port: config.viewer.port,
        reason: error instanceof Error ? error.message.slice(0, 300) : 'viewer dependencies unavailable'
      });
    }
  };

  startForgeViewer();

  const handleMessage = (message: BridgeMessage) => {
    if (message.type === 'state') {
      const state = parseState(message);
      if (state) {
        current = state;
        viewerState?.(state);
      }
      return;
    }

    if (message.type === 'bridge') {
      events.diagnostic?.('forge bridge connected', { port, protocol: message.protocol ?? null });
      return;
    }

    if (message.type === 'response') {
      if (typeof message.requestId === 'string') settlePending(message.requestId, message);
      return;
    }

    if (message.type !== 'event') return;

    switch (message.event) {
      case 'spawn':
        events.spawn();
        break;
      case 'worldReset':
        viewerReset?.();
        events.worldReset();
        break;
      case 'identity':
        if (typeof message.username === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(message.username)) {
          events.identity?.(message.username);
        }
        break;
      case 'message': {
        if (typeof message.text !== 'string') break;
        const raw = message.text;
        const clean = raw.replace(/§[0-9a-fk-or]/gi, '').trim();
        const text = clean.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
        const channel = typeof message.channel === 'string' ? message.channel.slice(0, 32) : 'unknown';

        if (text) events.diagnostic?.('chat message received', {
          channel,
          senderPresent: false,
          chatText: text
        });

        const candidate = parseInstance(raw);
        const eligible = eligibleTransferChannel(channel, null, config.transferMessageChannel, candidate !== undefined);
        const careAnnouncement = parseCarePackageAnnouncement(raw);
        const careEligible = eligibleServerAnnouncementChannel(channel, null, careAnnouncement !== undefined);
        const limboEligible = eligibleServerAnnouncementChannel(channel, null, isLimboNotice(raw));
        const deathEligible = eligibleServerAnnouncementChannel(channel, null, isDeathNotice(raw));

        if (!eligible && !careEligible && !limboEligible && !deathEligible) break;
        events.message(raw);
        break;
      }
      case 'blockUpdate': {
        if (!isFiniteNumber(message.x) || !isFiniteNumber(message.y) || !isFiniteNumber(message.z) ||
            !isFiniteNumber(message.stateId)) break;
        viewerBlockUpdate?.(message.x, message.y, message.z, message.stateId);
        break;
      }
      case 'chickenSpawn':
      case 'chestAppeared':
      case 'chestDisappeared': {
        if (!isFiniteNumber(message.x) || !isFiniteNumber(message.y) || !isFiniteNumber(message.z)) break;
        const position = { x: message.x, y: message.y, z: message.z };
        if (message.event === 'chickenSpawn') events.chickenSpawn?.(position);
        else if (message.event === 'chestAppeared') events.chestAppeared?.(position);
        else events.chestDisappeared?.(position);
        break;
      }
      case 'serverDisconnected':
      case 'end':
        events.serverDisconnected?.();
        break;
      default:
        events.diagnostic?.('forge bridge event', { event: message.event.slice(0, 64) });
        break;
    }
  };

  socket.on('connect', () => {
    connected = true;
    events.diagnostic?.('forge bridge socket ready', { port });
  });

  socket.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > 1_000_000) {
      buffer = '';
      events.error();
      return;
    }

    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line) as BridgeMessage);
      } catch {
        events.diagnostic?.('forge bridge invalid message');
      }
    }
  });

  socket.on('error', () => {
    if (!closed) events.error();
  });

  socket.on('close', () => {
    connected = false;
    failPending('Forge bridge disconnected');
    emitEnd();
  });

  const stopPath = () => {
    release();
  };

  const navigateTo = async (target: Position, range: number, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const started = Date.now();
    let bestDistance = Number.POSITIVE_INFINITY;
    let improvedAt = started;
    let collisionSince: number | undefined;

    try {
      while (true) {
        signal.throwIfAborted();
        if (closed || !connected) throw new Error('Transport closed');

        const state = current;
        if (!state) {
          if (Date.now() - started > 3000) throw new Error('Position unavailable');
          await delay(50, signal);
          continue;
        }

        const horizontal = Math.hypot(target.x - state.x, target.z - state.z);
        const vertical = Math.abs(target.y - state.y);
        if (horizontal <= range && vertical <= 1.5) return;

        if (horizontal + 0.08 < bestDistance) {
          bestDistance = horizontal;
          improvedAt = Date.now();
        }

        if (state.collidedH) collisionSince ??= Date.now();
        else collisionSince = undefined;

        if (collisionSince !== undefined && Date.now() - collisionSince > 1500) {
          throw new Error('Control walk collision');
        }
        if (Date.now() - improvedAt > 3000) throw new Error('Control walk stuck');

        const yaw = yawToward({ x: state.x, y: state.y, z: state.z }, target);
        const jump = state.onGround && (state.collidedH || target.y > state.y + 0.45);
        const sprint = state.onGround && horizontal > 3.0;

        send({ type: 'look', yaw, pitch: 0 });
        send({ type: 'controls', forward: true, sprint, sneak: false, jump });
        await delay(50, signal);
      }
    } finally {
      release();
    }
  };

  const navigateCached = async (target:Position, range:number, signal:AbortSignal):Promise<void> => {
    const instanceId=boundInstanceId;
    if(!instanceId){
      await navigateTo(target,range,signal);
      return;
    }

    const avoided=new Map<string,{x:number;z:number}>();
    let replans=0;
    while(replans++<12){
      signal.throwIfAborted();
      const state=current;
      if(!state)throw new Error('Position unavailable');
      const start={x:state.x,y:state.y,z:state.z};
      const horizontal=Math.hypot(target.x-start.x,target.z-start.z);
      const vertical=Math.abs(target.y-start.y);
      if(horizontal<=range&&vertical<=1.5)return;

      const plannedAt=Date.now();
      const plan=await sharedPitNavigation.plan(
        instanceId,start,target,loadPitChunk,signal,[...avoided.values()],listLoadedPitChunks
      );
      events.diagnostic?.('pit path planned',{
        instanceId,
        fingerprint:plan.fingerprint,
        waypoints:plan.waypoints.length,
        complete:plan.complete,
        scannedChunks:plan.scannedChunks,
        expandedNodes:plan.expandedNodes,
        planningMs:Date.now()-plannedAt
      });
      if(!plan.waypoints.length)throw new Error('No path to the goal!');

      let advanced=false;
      let replanRequested=false;
      for(const waypoint of plan.waypoints){
        signal.throwIfAborted();
        try{
          await navigateTo(waypoint,0.7,signal);
          advanced=true;
        }catch(error){
          const message=error instanceof Error?error.message:'';
          if(message==='Control walk collision'||message==='Control walk stuck'){
            const blockedFrom=current;
            if(blockedFrom){
              const dx=waypoint.x-blockedFrom.x,dz=waypoint.z-blockedFrom.z,length=Math.hypot(dx,dz)||1;
              const blockedX=Math.floor(blockedFrom.x+dx/length*0.9);
              const blockedZ=Math.floor(blockedFrom.z+dz/length*0.9);
              avoided.set(`${blockedX},${blockedZ}`,{x:blockedX,z:blockedZ});
            }
            events.diagnostic?.('pit path replan requested',{
              instanceId,
              reason:message,
              avoidedColumns:avoided.size,
              waypointX:Math.round(waypoint.x*10)/10,
              waypointY:Math.round(waypoint.y*10)/10,
              waypointZ:Math.round(waypoint.z*10)/10
            });
            replanRequested=true;
            break;
          }
          throw error;
        }
      }

      const after=current;
      if(!after)throw new Error('Position unavailable');
      const afterHorizontal=Math.hypot(target.x-after.x,target.z-after.z);
      const afterVertical=Math.abs(target.y-after.y);
      if(afterHorizontal<=range+0.6&&afterVertical<=1.5)return;
      if(!advanced&&!replanRequested)throw new Error('No path to the goal!');
      await delay(75,signal);
    }
    throw new Error('No path to the goal!');
  };

  const navigate = (target: Position, signal: AbortSignal) => navigateCached(target, 1.0, signal);

  const launchToward = async (
    target: Pick<Position, 'x' | 'z'>,
    signal: AbortSignal,
    completion: 'LAUNCH' | 'LANDING' = 'LANDING'
  ): Promise<void> => {
    signal.throwIfAborted();
    const start = current;
    if (!start) throw new Error('Launch position unavailable');

    const response = await request({ type: 'findSlimePads', radius: 32, vertical: 6, limit: 96 }, signal);
    if (!response.ok || response.kind !== 'slimePads' || !Array.isArray(response.blocks)) {
      throw new Error('Launch pad unavailable');
    }

    const slime = response.blocks.flatMap(block =>
      isFiniteNumber(block.x) && isFiniteNumber(block.y) && isFiniteNumber(block.z)
        ? [{ x: block.x, y: block.y, z: block.z }]
        : []
    ).filter(pos => Math.abs(pos.y - start.y) <= 6);

    if (!slime.length) throw new Error('Launch pad not found');

    const remaining = [...slime];
    const clusters: Array<typeof slime> = [];
    while (remaining.length) {
      const seed = remaining.pop()!;
      const cluster = [seed];
      for (let changed = true; changed;) {
        changed = false;
        for (let i = remaining.length - 1; i >= 0; i--) {
          const candidate = remaining[i]!;
          if (cluster.some(p =>
            Math.abs(p.x - candidate.x) <= 1 &&
            Math.abs(p.y - candidate.y) <= 1 &&
            Math.abs(p.z - candidate.z) <= 1)) {
            cluster.push(remaining.splice(i, 1)[0]!);
            changed = true;
          }
        }
      }
      if (cluster.length >= 4) clusters.push(cluster);
    }
    if (!clusters.length) throw new Error('Launch pad not found');

    const centers = clusters.map(cluster => ({
      x: cluster.reduce((sum, p) => sum + p.x, 0) / cluster.length + 0.5,
      y: Math.max(...cluster.map(p => p.y)) + 1,
      z: cluster.reduce((sum, p) => sum + p.z, 0) / cluster.length + 0.5,
      blocks: cluster.length
    })).filter(center => Math.hypot(center.x - start.x, center.z - start.z) >= 4);

    if (!centers.length) throw new Error('Launch pad not found');

    const tx = target.x - start.x;
    const tz = target.z - start.z;
    const targetLength = Math.hypot(tx, tz) || 1;
    centers.sort((a, b) => {
      const score = (p: typeof a) => {
        const px = p.x - start.x;
        const pz = p.z - start.z;
        const length = Math.hypot(px, pz) || 1;
        return (px * tx + pz * tz) / (length * targetLength);
      };
      return score(b) - score(a);
    });

    const pad = centers[0]!;
    events.diagnostic?.('launch pad selected', {
      candidates: centers.length,
      blocks: pad.blocks,
      padX: Math.round(pad.x * 10) / 10,
      padY: Math.round(pad.y * 10) / 10,
      padZ: Math.round(pad.z * 10) / 10
    });

    const dx = pad.x - start.x;
    const dz = pad.z - start.z;
    const distance = Math.hypot(dx, dz) || 1;
    const approach = {
      x: pad.x - dx / distance * 2.2,
      y: pad.y,
      z: pad.z - dz / distance * 2.2
    };

    events.diagnostic?.('launch pad approach', {
      startX: Math.round(start.x * 10) / 10,
      startY: Math.round(start.y * 10) / 10,
      startZ: Math.round(start.z * 10) / 10,
      approachX: Math.round(approach.x * 10) / 10,
      approachY: Math.round(approach.y * 10) / 10,
      approachZ: Math.round(approach.z * 10) / 10,
      distance: Math.round(distance * 10) / 10
    });

    await navigateCached(approach, 0.8, signal);
    signal.throwIfAborted();

    const beforeLaunch = current;
    if (!beforeLaunch) throw new Error('Launch position unavailable');
    send({ type: 'look', yaw: yawToward(
      { x: beforeLaunch.x, y: beforeLaunch.y, z: beforeLaunch.z },
      { x: pad.x, y: pad.y, z: pad.z }
    ), pitch: 0 });
    send({ type: 'controls', forward: true, sprint: false, sneak: false, jump: false });

    const launchedFrom = { x: beforeLaunch.x, y: beforeLaunch.y, z: beforeLaunch.z };
    const launchedAt = Date.now();
    let launched = false;
    let groundSamples = 0;

    try {
      while (true) {
        signal.throwIfAborted();
        const state = current;
        if (state) {
          const horizontal = Math.hypot(state.x - launchedFrom.x, state.z - launchedFrom.z);
          if (!launched && (horizontal > 7 || Math.abs(state.y - launchedFrom.y) > 4)) {
            launched = true;
            release();
            if (completion === 'LAUNCH') return;
          }
          if (launched) {
            groundSamples = state.onGround ? groundSamples + 1 : 0;
            if (groundSamples >= 2 && horizontal > 7) return;
          }
        }
        if (Date.now() - launchedAt > 10_000) {
          throw new Error(launched ? 'Launch landing timeout' : 'Launch pad did not trigger');
        }
        await delay(50, signal);
      }
    } finally {
      release();
    }
  };

  return {
    position: () => current ? { x: current.x, y: current.y, z: current.z } : undefined,
    ping: () => current?.pingMs,
    setInstance: instanceId => {
      if(boundInstanceId===instanceId)return;
      if(boundInstanceId)sharedPitNavigation.releaseInstance(boundInstanceId);
      boundInstanceId=instanceId;
      if(instanceId)sharedPitNavigation.retainInstance(instanceId);
    },
    chat: command => {
      if (closed) throw new Error('Transport closed');
      send({ type: 'chat', message: command });
    },
    connectServer,
    disconnectServer,
    navigate,
    launchToward,
    stopPath,
    close: () => {
      if (closed) return;
      if(boundInstanceId){
        sharedPitNavigation.releaseInstance(boundInstanceId);
        boundInstanceId=undefined;
      }
      try { release(); } catch {}
      closed = true;
      viewerClose?.();
      viewerClose = undefined;
      failPending('Transport closed');
      socket.destroy();
    }
  };
}

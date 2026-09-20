import net from 'node:net';
import type { Config } from '../config/index.js';
import type { Position } from '../core/types.js';
import { parseInstance } from '../instances/parser.js';
import { parseCarePackageAnnouncement } from '../events/care-package.js';
import { eligibleServerAnnouncementChannel, eligibleTransferChannel } from './message-source.js';
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
}

type BridgeMessage =
  | BridgeState
  | BridgeEvent
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
      typeof state.bridgeControl !== 'boolean') return undefined;
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

  const handleMessage = (message: BridgeMessage) => {
    if (message.type === 'state') {
      const state = parseState(message);
      if (state) current = state;
      return;
    }

    if (message.type === 'bridge') {
      events.diagnostic?.('forge bridge connected', { port, protocol: message.protocol ?? null });
      return;
    }

    if (message.type !== 'event') return;

    switch (message.event) {
      case 'spawn':
        events.spawn();
        break;
      case 'worldReset':
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

        if (!eligible && !careEligible) break;
        events.message(raw);
        break;
      }
      case 'chickenSpawn':
      case 'chestAppeared': {
        if (!isFiniteNumber(message.x) || !isFiniteNumber(message.y) || !isFiniteNumber(message.z)) break;
        const position = { x: message.x, y: message.y, z: message.z };
        if (message.event === 'chickenSpawn') events.chickenSpawn?.(position);
        else events.chestAppeared?.(position);
        break;
      }
      case 'end':
        emitEnd();
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
    emitEnd();
  });

  const stopPath = () => {
    release();
  };

  const navigate = async (target: Position, signal: AbortSignal): Promise<void> => {
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
        if (horizontal <= 1.0 && vertical <= 1.5) return;

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

  return {
    position: () => current ? { x: current.x, y: current.y, z: current.z } : undefined,
    chat: command => {
      if (closed) throw new Error('Transport closed');
      send({ type: 'chat', message: command });
    },
    navigate,
    stopPath,
    close: () => {
      if (closed) return;
      try { release(); } catch {}
      closed = true;
      socket.destroy();
    }
  };
}

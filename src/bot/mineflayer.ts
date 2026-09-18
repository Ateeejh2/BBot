import { createBot } from 'mineflayer';
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder';
import { join } from 'node:path';
import { parseInstance } from '../instances/parser.js';
import { eligibleTransferChannel } from './message-source.js';
import type { Config } from '../config/index.js';
import type { BotTransport, TransportEvents } from './transport.js';
/** The only module allowed to import Mineflayer. */
export function createMineflayerTransport(config: Config, index: number, events: TransportEvents): BotTransport {
  const account = config.accounts[index]!;
  const bot = createBot({ host: config.host, port: config.port, username: account.username,
    auth: account.auth, version: config.version, profilesFolder: join(config.authDir, account.label),
    hideErrors: true, logErrors: false,
    // Auth code is interactive console output only, never structured/file logs.
    onMsaCode: data => process.stderr.write(`[${account.label}] Microsoft sign-in: ${data.verification_uri} code: ${data.user_code}\n`)
  });
  bot.loadPlugin(pathfinder);
  let closed = false;
  const stopPath = () => { bot.pathfinder.setGoal(null); bot.clearControlStates(); };
  const spawn = () => {
    const movements = new Movements(bot);
    movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false;
    movements.scafoldingBlocks = []; movements.allowFreeMotion = false;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.tickTimeout = 10;
    bot.pathfinder.thinkTimeout = config.pathTimeoutMs;
    events.diagnostic?.('spawn observed', { inventorySlots: bot.inventory?.slots.length ?? null });
    events.spawn();
  };
  const reset = () => { events.diagnostic?.('respawn observed'); events.worldReset(); };
  const windowOpen = () => events.diagnostic?.('window opened');
  const windowClose = () => events.diagnostic?.('window closed');
  const message = (text: string, position: string, _json: unknown, sender?: string | null) => {
    // On legacy protocol, the network may deliver server text in chat (unverified).
    // Observe both channels without recording message contents. Chat requires explicit opt-in.
    const candidate = parseInstance(text);
    const eligible = eligibleTransferChannel(position, sender, config.transferMessageChannel);
    if (candidate) events.diagnostic?.('transfer text observed', { channel: position, senderPresent: Boolean(sender), eligible });
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
  bot.on('spawn', spawn); bot.on('respawn', reset); bot.on('messagestr', message);
  bot.on('kicked', kicked); bot.on('end', end); bot.on('error', error);
  if (config.level === 'debug') { bot.on('windowOpen', windowOpen); bot.on('windowClose', windowClose); }
  return {
    position: () => bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : undefined,
    chat: command => { if (closed) throw new Error('Transport closed'); bot.chat(command); },
    navigate: async (target, signal) => {
      signal.throwIfAborted();
      const abort = () => stopPath();
      signal.addEventListener('abort', abort, { once: true });
      try {
        await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1)); signal.throwIfAborted();
        const p = bot.entity?.position;
        if (!p || Math.hypot(Math.floor(p.x) - Math.floor(target.x), Math.floor(p.y) - Math.floor(target.y), Math.floor(p.z) - Math.floor(target.z)) > 1) throw new Error('Path ended before arrival');
      }
      finally { signal.removeEventListener('abort', abort); }
    },
    stopPath,
    close: () => {
      if (closed) return; closed = true;
      stopPath();
      bot.removeListener('spawn', spawn); bot.removeListener('respawn', reset); bot.removeListener('messagestr', message);
      bot.removeListener('kicked', kicked); bot.removeListener('end', end); bot.removeListener('windowOpen', windowOpen); bot.removeListener('windowClose', windowClose);
      // Keep the guarded error listener until transport GC to absorb late socket errors.
      bot.end('BBot stopped');
    }
  };
}

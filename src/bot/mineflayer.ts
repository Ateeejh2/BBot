import { createBot } from 'mineflayer';
import pathfinderModule from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderModule;
import { join } from 'node:path';
import { parseInstance } from '../instances/parser.js';
import { eligibleTransferChannel } from './message-source.js';
import type { Config } from '../config/index.js';
import type { BotTransport, TransportEvents } from './transport.js';
type ViewerStarter = (bot: ReturnType<typeof createBot>, options: { port: number; firstPerson: boolean; viewDistance: number }) => void;
type ViewerModule = { mineflayer?: ViewerStarter; default?: { mineflayer?: ViewerStarter } };
type ViewerBot = ReturnType<typeof createBot> & { viewer?: { close(): void } };
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
  let viewerStarted = false;
  let viewerStarting = false;
  const stopPath = () => { bot.pathfinder.setGoal(null); bot.clearControlStates(); };
  const startViewer = async () => {
    const botId = `bot-${index + 1}`;
    if (!config.viewer.enabled || config.viewer.botId !== botId || viewerStarted || viewerStarting || closed) return;
    viewerStarting = true;
    try {
      // Keep prismarine-viewer optional so normal BBot installs and CI do not pull a renderer stack.
      const moduleName = 'prismarine-viewer';
      const loaded = await import(moduleName) as ViewerModule;
      const mineflayerViewer = loaded.mineflayer ?? loaded.default?.mineflayer;
      if (typeof mineflayerViewer !== 'function') throw new Error('mineflayer viewer export missing');
      mineflayerViewer(bot, {
        port: config.viewer.port,
        firstPerson: config.viewer.firstPerson,
        viewDistance: config.viewer.viewDistance
      });
      viewerStarted = true;
      events.diagnostic?.('viewer started', { botId, port: config.viewer.port, firstPerson: config.viewer.firstPerson, viewDistance: config.viewer.viewDistance });
    } catch {
      process.stderr.write(`[${account.label}] Viewer could not start. Run "npm run setup:viewer" and restart BBot.\n`);
      events.diagnostic?.('viewer start failed', { botId, port: config.viewer.port });
    } finally {
      viewerStarting = false;
    }
  };
  const spawn = () => {
    const movements = new Movements(bot);
    movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false;
    movements.scafoldingBlocks = []; movements.allowFreeMotion = false;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.tickTimeout = 10;
    bot.pathfinder.thinkTimeout = config.pathTimeoutMs;
    events.diagnostic?.('spawn observed', { inventorySlots: bot.inventory?.slots.length ?? null });
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
    const eligible = eligibleTransferChannel(position, sender, config.transferMessageChannel);
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
      try { (bot as ViewerBot).viewer?.close(); } catch { /* Viewer shutdown must not block bot shutdown. */ }
      viewerStarted = false;
      // Keep the guarded error listener until transport GC to absorb late socket errors.
      bot.end('BBot stopped');
    }
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config/index.js';
import { BotManager } from '../src/bot/manager.js';
import type { BotTransport, TransportEvents } from '../src/bot/transport.js';
import type { Position } from '../src/core/types.js';
import { InstanceRegistry } from '../src/instances/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { PathfindingController } from '../src/pathfinding/controller.js';
import { MockTaskHandler } from '../src/events/task.js';
import { Logger } from '../src/logging/logger.js';
import { ControlStore } from '../src/runtime/control.js';
import { classifyDisconnectReason } from '../src/runtime/kick-ban.js';

class KickTransport implements BotTransport {
  constructor(readonly events: TransportEvents) {}
  position(): Position { return { x:0, y:64, z:0 }; }
  chat(_command: string): void {}
  async navigate(_target: Position, _signal: AbortSignal): Promise<void> {}
  stopPath(): void {}
  close(): void {}
}

function managerFor(config: ReturnType<typeof loadConfig>, capture: (transport: KickTransport) => void) {
  return new BotManager(config, (_index, events) => {
    const transport = new KickTransport(events);
    capture(transport);
    return transport;
  }, new InstanceRegistry(), new Scheduler(3, 100, 100),
  new PathfindingController(1, 1000), new MockTaskHandler(), new Logger('error'));
}

test('disconnect classifier only marks explicit ban language as BAN', () => {
  assert.equal(classifyDisconnectReason('Disconnected: duplicate login'), 'KICK');
  assert.equal(classifyDisconnectReason('Internal Exception: connection reset'), 'KICK');
  assert.equal(classifyDisconnectReason('You are temporarily banned for 29d from this server!'), 'BAN');
  assert.equal(classifyDisconnectReason('You are permanently banned from this server! Reason: test'), 'BAN');
  assert.equal(classifyDisconnectReason('Ban ID: #ABC123'), 'BAN');
});

test('ban reason persists with the account across stop, restart and reassignment', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.test-kick-ban-'));
  const env = {
    MODE:'live', API_ENABLED:'true', API_ORIGIN:'http://localhost:5173',
    ACCOUNTS_FILE:join(dir,'missing.json'), DATA_DIR:dir, BOT_COUNT:'1'
  };
  let transport: KickTransport | undefined;
  let manager: BotManager | undefined;
  let restartedManager: BotManager | undefined;
  try {
    const config = loadConfig(env);
    config.authDir = join(dir, '.auth');
    const controls = new ControlStore(config, async () => ({ minecraftName:'BannedMC' }));
    await controls.load();
    manager = managerFor(config, value => { transport = value; });
    await controls.bind(manager);

    const created = await controls.addAccount({ kind:'MICROSOFT', label:'BannedAccount' });
    await delay(20);
    const assigned = controls.listAccounts().find(account => account.id === created.id);
    assert.equal(assigned?.status, 'READY');
    assert.equal(assigned?.assignedBot, 'bot-1');

    manager.connectBot('bot-1');
    assert.ok(transport);
    transport.events.kicked?.('You are permanently banned from this server! Reason: test ban', true);
    await delay(20);

    const detected = controls.listAccounts().find(account => account.id === created.id);
    assert.equal(detected?.ban?.kind, 'BAN');
    assert.equal(detected?.ban?.reason, 'You are permanently banned from this server! Reason: test ban');
    assert.equal(manager.views()[0]?.moderation?.kind, 'BAN');
    assert.equal(manager.views()[0]?.moderation?.persistent, true);

    const stored = JSON.parse(await readFile(join(dir, 'accounts-runtime.json'), 'utf8')) as Array<{id:string;ban?:{kind:string;reason:string;detectedAt:number}}>;
    assert.equal(stored.find(account => account.id === created.id)?.ban?.kind, 'BAN');

    manager.stop();
    manager = undefined;

    const config2 = loadConfig(env);
    config2.authDir = join(dir, '.auth');
    const controls2 = new ControlStore(config2, async () => ({ minecraftName:'BannedMC' }));
    await controls2.load();
    restartedManager = managerFor(config2, () => {});
    await controls2.bind(restartedManager);

    assert.equal(restartedManager.views()[0]?.state, 'DISCONNECTED');
    assert.equal(restartedManager.views()[0]?.moderation?.kind, 'BAN');
    assert.equal(restartedManager.views()[0]?.moderation?.reason, 'You are permanently banned from this server! Reason: test ban');

    await controls2.assign('bot-1', { accountId:null });
    assert.equal(restartedManager.views()[0]?.moderation, undefined);
    await controls2.assign('bot-1', { accountId:created.id });
    assert.equal(restartedManager.views()[0]?.moderation?.kind, 'BAN');

    await controls2.deleteAccount(created.id);
    assert.equal(controls2.listAccounts().length, 0);
    assert.equal(restartedManager.views()[0]?.moderation, undefined);
  } finally {
    manager?.stop();
    restartedManager?.stop();
    await rm(dir, { recursive:true, force:true });
  }
});

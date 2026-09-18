import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config/index.js';
import { BotManager } from '../src/bot/manager.js';
import { InstanceRegistry } from '../src/instances/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { PathfindingController } from '../src/pathfinding/controller.js';
import { Logger } from '../src/logging/logger.js';
import { MockTaskHandler, type TaskHandler } from '../src/events/task.js';
import type { BotTransport, TransportEvents } from '../src/bot/transport.js';
import type { Position } from '../src/core/types.js';
class ControlledTransport implements BotTransport {
  commands: string[] = []; closed = false; stopped = 0;
  navigation: (target: Position, signal: AbortSignal) => Promise<void> = async () => {};
  constructor(readonly events: TransportEvents) {}
  position() { return { x: 0, y: 64, z: 0 }; }
  chat(command: string) { this.commands.push(command); }
  navigate(target: Position, signal: AbortSignal) { return this.navigation(target, signal); }
  stopPath() { this.stopped++; }
  close() { this.closed = true; }
}
function fixture(count = 1, task: TaskHandler = new MockTaskHandler(), apiEnabled = false) {
  let now = 0; const connections: ControlledTransport[] = [];
  const config = loadConfig({ BOT_COUNT: String(count), CONNECTION_SPACING_MS: '100', PLAY_COOLDOWN_MS: '1000', JOIN_TIMEOUT_MS: '1000', RECONNECT_BASE_MS: '100', RECONNECT_MAX_MS: '1000', JOB_RETRY_MS: '100', TASK_TIMEOUT_MS: '100', ...(apiEnabled ? { API_ENABLED: 'true', API_ORIGIN: 'http://localhost:5173' } : {}) });
  const scheduler = new Scheduler(3, 100, 100); const paths = new PathfindingController(2, 1000);
  const registry = new InstanceRegistry();
  const manager = new BotManager(config, (_i, events) => { const t = new ControlledTransport(events); connections.push(t); return t; }, registry, scheduler, paths, task, new Logger('error'), () => now, () => 1);
  const tick = (at: number) => { now = at; manager.tick(); };
  const join = (transport: ControlledTransport, id = 'a') => { transport.events.message(`SERVER FOUND! Sending to ${id}!`); transport.events.worldReset(); transport.events.spawn(); };
  return { config, manager, scheduler, paths, registry, connections, tick, join };
}
test('first connection waits for spawn and cooldown; notification alone does not assign membership', () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!;
  assert.equal(f.manager.views()[0]?.state, 'CONNECTING'); assert.deepEqual(t.commands, []);
  t.events.spawn(); f.tick(999); assert.deepEqual(t.commands, []); f.tick(1000);
  assert.deepEqual(t.commands, ['/play pit']); t.events.message('SERVER FOUND! Sending to New-9!');
  assert.equal(f.manager.views()[0]?.instanceId, undefined);
  t.events.worldReset(); t.events.spawn(); assert.equal(f.manager.views()[0]?.instanceId, 'new-9'); f.manager.stop();
});
test('kick reason is retained on the individual bot view', () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!;
  t.events.kicked?.('Disconnected: duplicate login', true);
  const view = f.manager.views()[0]!;
  assert.equal(view.state, 'DISCONNECTED');
  assert.equal(view.kickReason, 'Disconnected: duplicate login');
  assert.equal(view.kickedAt, 0);
  f.manager.stop();
});
test('invalid Session auth after connection failure pauses automatic reconnect', async () => {
  const f = fixture(1, new MockTaskHandler(), true);
  f.config.mode = 'live';
  const account = { label:'Session', username:'SessionMC', auth:'mojang' as const, kind:'SESSION' as const, accountId:'11111111-1111-4111-8111-111111111111' };
  f.manager.assignAccount('bot-1', account.accountId, account, 'SessionMC');
  let checked = 0;
  f.manager.setSessionFailureHandler(async (botId, accountId) => {
    checked++;
    assert.equal(botId,'bot-1'); assert.equal(accountId,account.accountId);
    return true;
  });
  f.manager.connectBot('bot-1');
  const t = f.connections[0]!;
  t.events.error();
  await delay(0);
  assert.equal(checked,1);
  assert.equal(f.manager.views()[0]?.state,'DISCONNECTED');
  f.tick(1000);
  assert.equal(f.connections.length,1);
  f.manager.stop();
});
test('explicit multi-bot starts honor global connection spacing', () => {
  const f = fixture(2, new MockTaskHandler(), true);
  f.config.mode = 'live';
  f.manager.assignAccount('bot-1','11111111-1111-4111-8111-111111111111',{label:'A',username:'A',auth:'offline'},'A');
  f.manager.assignAccount('bot-2','22222222-2222-4222-8222-222222222222',{label:'B',username:'B',auth:'offline'},'B');
  f.manager.connectBot('bot-1');
  f.manager.connectBot('bot-2');
  assert.equal(f.connections.length,1);
  assert.equal(f.manager.views()[0]?.state,'CONNECTING');
  assert.equal(f.manager.views()[1]?.state,'DISCONNECTED');
  f.tick(99); assert.equal(f.connections.length,1);
  f.tick(100); assert.equal(f.connections.length,2);
  assert.equal(f.manager.views()[1]?.state,'CONNECTING');
  const stopped=f.manager.stopAllBots();
  assert.deepEqual(stopped.sort(),['bot-1','bot-2']);
  assert.ok(f.manager.views().every(b=>b.state==='DISCONNECTED'));
  f.manager.stop();
});
test('web Start automatically continues from lobby into Pit after cooldown', () => {
  const f = fixture(1, new MockTaskHandler(), true);
  f.tick(0); assert.equal(f.connections.length, 0); assert.equal(f.manager.views()[0]?.state, 'DISCONNECTED');
  f.manager.connectBot('bot-1'); const t = f.connections[0]!;
  assert.equal(f.manager.views()[0]?.state, 'CONNECTING');
  t.events.spawn(); assert.equal(f.manager.views()[0]?.state, 'LOBBY');
  f.tick(999); assert.deepEqual(t.commands, []);
  f.tick(1000); assert.deepEqual(t.commands, ['/play pit']); assert.equal(f.manager.views()[0]?.state, 'JOINING_PIT');
  f.join(t, 'auto'); assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE'); assert.equal(f.manager.views()[0]?.instanceId, 'auto');
  f.manager.stop();
});
test('notification after spawn remains unconfirmed and cannot schedule a job', () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000);
  t.events.spawn(); t.events.message('SERVER FOUND! Sending to a!');
  assert.equal(f.manager.views()[0]?.state, 'JOINING_PIT'); f.tick(2000);
  assert.equal(f.manager.views()[0]?.state, 'RECOVERING'); f.manager.stop();
});
test('connections and reconnects are globally staggered and old transport callbacks ignored', () => {
  const f = fixture(2); f.tick(0); assert.equal(f.connections.length, 1);
  f.tick(99); assert.equal(f.connections.length, 1); f.tick(100); assert.equal(f.connections.length, 2);
  const old = f.connections[0]!; old.events.end(); f.tick(199); assert.equal(f.connections.length, 2);
  f.tick(200); assert.equal(f.connections.length, 3);
  old.events.spawn(); old.events.message('SERVER FOUND! Sending to wrong!'); old.events.end();
  assert.equal(f.manager.views()[0]?.state, 'CONNECTING'); assert.equal(f.manager.views()[0]?.instanceId, undefined); f.manager.stop();
});
test('lost membership aborts path, returns job and rejects a stale completion', async () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  let late!: () => void;
  t.navigation = () => new Promise(resolve => { late = resolve; });
  f.scheduler.enqueue({ id: 'job', instanceId: 'a', target: { x: 0, y: 64, z: 0 }, type: 'mock', expiresAt: 100000 }, 1000);
  f.tick(1001); await delay(0); assert.equal(f.manager.views()[0]?.state, 'PATHFINDING');
  f.manager.notifyLobbyReturn('bot-1'); assert.equal(f.scheduler.jobs.get('job')?.state, 'QUEUED');
  assert.equal(f.manager.views()[0]?.instanceId, undefined); assert.equal(f.paths.active, 0);
  f.tick(2001); f.join(t, 'new'); late(); await delay(0);
  assert.equal(f.manager.views()[0]?.instanceId, 'new'); assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE');
  assert.equal(f.scheduler.jobs.get('job')?.state, 'QUEUED'); f.manager.stop();
});
test('late task completion cannot finish a returned job or overwrite new instance', async () => {
  let late!: () => void;
  const f = fixture(1, { onArrive: () => new Promise(resolve => { late = resolve; }) });
  f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  f.scheduler.enqueue({ id: 'job', instanceId: 'a', target: { x: 0, y: 64, z: 0 }, type: 'mock', expiresAt: 100000 }, 1000);
  f.tick(1001); await delay(1); assert.equal(f.manager.views()[0]?.state, 'WORKING');
  t.events.worldReset(); assert.equal(f.manager.views()[0]?.state, 'RECOVERING'); t.events.spawn();
  f.tick(2001); f.join(t, 'b'); late(); await delay(1);
  assert.equal(f.scheduler.jobs.get('job')?.state, 'QUEUED'); assert.equal(f.manager.views()[0]?.instanceId, 'b'); f.manager.stop();
});
test('unknown world reset invalidates membership but does not claim AFK/crash', () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  t.events.worldReset(); assert.equal(f.manager.views()[0]?.state, 'RECOVERING');
  assert.equal(f.registry.records.get('a')?.status, 'ACTIVE'); assert.equal(f.registry.records.get('a')?.bots.size, 0);
  f.manager.stop();
});
test('missing transfer confirmations exhaust bounded command attempts', () => {
  const f = fixture(); f.config.joinMaxAttempts = 2;
  f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.tick(2000); f.tick(3000); f.tick(4000); f.tick(5000); f.tick(100000);
  assert.equal(t.commands.length, 2); f.manager.stop();
});
test('shutdown stops transports, cancels paths and preserves queued work', async () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  t.navigation = () => new Promise(() => {});
  f.scheduler.enqueue({ id: 'job', instanceId: 'a', target: { x: 0, y: 64, z: 0 }, type: 'mock', expiresAt: 100000 }, 1000);
  f.tick(1001); await delay(0); f.manager.stop(); await delay(0);
  assert.equal(t.closed, true); assert.equal(f.paths.active, 0); assert.equal(f.scheduler.jobs.get('job')?.state, 'QUEUED');
  f.tick(100000); assert.equal(f.connections.length, 1);
});
test('unsolicited transfer invalidates work before new membership is confirmed', async () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  t.navigation = () => new Promise(() => {});
  f.scheduler.enqueue({ id: 'job', instanceId: 'a', target: { x: 0, y: 64, z: 0 }, type: 'mock', expiresAt: 100000 }, 1000);
  f.tick(1001); await delay(0);
  t.events.message('SERVER FOUND! Sending to different!');
  assert.equal(f.manager.views()[0]?.instanceId, undefined); assert.equal(f.scheduler.jobs.get('job')?.state, 'QUEUED');
  t.events.spawn(); assert.equal(f.manager.views()[0]?.instanceId, 'different'); f.manager.stop();
});
test('task timeout returns job and does not leave bot WORKING', async () => {
  const f = fixture(1, { onArrive: () => new Promise(() => {}) });
  f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  f.scheduler.enqueue({ id: 'job', instanceId: 'a', target: { x: 0, y: 64, z: 0 }, type: 'mock', expiresAt: 100000 }, 1000);
  f.tick(1001); await delay(130);
  assert.equal(f.scheduler.jobs.get('job')?.state, 'QUEUED'); assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE'); f.manager.stop();
});

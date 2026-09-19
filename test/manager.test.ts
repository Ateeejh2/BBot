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
import { CarePackageCoordinator } from '../src/events/care-package.js';
class ControlledTransport implements BotTransport {
  commands: string[] = []; closed = false; stopped = 0;
  navigation: (target: Position, signal: AbortSignal) => Promise<void> = async () => {};
  launcher: (target: Pick<Position,'x'|'z'>, signal: AbortSignal) => Promise<void> = async () => {};
  launches: Array<Pick<Position,'x'|'z'>> = [];
  constructor(readonly events: TransportEvents) {}
  position() { return { x: 0, y: 64, z: 0 }; }
  chat(command: string) { this.commands.push(command); }
  navigate(target: Position, signal: AbortSignal) { return this.navigation(target, signal); }
  launchToward(target: Pick<Position,'x'|'z'>, signal: AbortSignal) { this.launches.push({...target}); return this.launcher(target,signal); }
  stopPath() { this.stopped++; }
  close() { this.closed = true; }
}
function fixture(count = 1, task: TaskHandler = new MockTaskHandler(), apiEnabled = false, carePackages?:CarePackageCoordinator) {
  let now = 0; const connections: ControlledTransport[] = [];
  const config = loadConfig({ BOT_COUNT: String(count), CONNECTION_SPACING_MS: '100', PLAY_COOLDOWN_MS: '1000', JOIN_TIMEOUT_MS: '1000', RECONNECT_BASE_MS: '100', RECONNECT_MAX_MS: '1000', JOB_RETRY_MS: '100', TASK_TIMEOUT_MS: '100', ...(apiEnabled ? { API_ENABLED: 'true', API_ORIGIN: 'http://localhost:5173' } : {}) });
  const scheduler = new Scheduler(3, 100, 100); const paths = new PathfindingController(2, 1000);
  const registry = new InstanceRegistry();
  const manager = new BotManager(config, (_i, events) => { const t = new ControlledTransport(events); connections.push(t); return t; }, registry, scheduler, paths, task, new Logger('error'), () => now, () => 1, undefined, carePackages);
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
test('movement debug connects then continuously pathfinds without joining Pit', async () => {
  const f = fixture();
  f.manager.setMovementDebug(true);
  f.tick(0);
  const t = f.connections[0]!;
  const targets: Position[] = [];
  const finishes: Array<() => void> = [];
  t.navigation = (next) => new Promise<void>(resolve => { targets.push({...next}); finishes.push(resolve); });
  t.events.spawn();
  await delay(0);
  assert.equal(f.manager.views()[0]?.state,'PATHFINDING');
  assert.deepEqual(targets[0],{x:6,y:64,z:0});
  assert.deepEqual(t.commands,[]);
  f.tick(10_000);
  assert.deepEqual(t.commands,[]);
  t.events.message('SERVER FOUND! Sending to mega-debug!');
  assert.equal(f.manager.views()[0]?.instanceId,undefined);
  finishes[0]!(); await delay(0);
  assert.equal(f.manager.views()[0]?.state,'PATHFINDING');
  assert.deepEqual(targets[1],{x:0,y:64,z:6});
  assert.equal(f.manager.movementDebugEnabled(),true);
  f.manager.stop();
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
test('queued bot rejects duplicate start and account changes until cancelled', () => {
  const f = fixture(2, new MockTaskHandler(), true);
  f.config.mode = 'live';
  const accountA = { label:'A', username:'A', auth:'offline' as const };
  const accountB = { label:'B', username:'B', auth:'offline' as const };
  f.manager.assignAccount('bot-1','11111111-1111-4111-8111-111111111111',accountA,'A');
  f.manager.assignAccount('bot-2','22222222-2222-4222-8222-222222222222',accountB,'B');
  f.manager.connectBot('bot-1');
  f.manager.connectBot('bot-2');
  assert.equal(f.manager.views()[1]?.startQueued, true);
  assert.throws(() => f.manager.connectBot('bot-2'), { message:'INVALID_STATE' });
  assert.throws(() => f.manager.assignAccount('bot-2','33333333-3333-4333-8333-333333333333',accountB,'B'), { message:'INVALID_STATE' });
  assert.throws(() => f.manager.unassignAccount('bot-2'), { message:'INVALID_STATE' });
  f.manager.disconnectBot('bot-2');
  assert.equal(f.manager.views()[1]?.startQueued, false);
  assert.equal(f.manager.isBotStopped('bot-2'), true);
  f.manager.unassignAccount('bot-2');
  assert.equal(f.manager.views()[1]?.accountId, undefined);
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
test('Care Package carrier detection launches from spawn before chest Job assignment', async () => {
  const schedule={refresh:async()=>{},snapshot:()=>({source:'brookeafk.com' as const,sourceUrl:'https://brookeafk.com/',status:'OK' as const,events:[{timestamp:1000}]}),eventsBetween:()=>[{timestamp:1000}]};
  const coordinator=new CarePackageCoordinator(schedule,60_000,180_000,2_000,6,3);
  const f=fixture(1,new MockTaskHandler(),false,coordinator);
  f.tick(0);const t=f.connections[0]!;t.events.spawn();f.tick(1000);f.join(t,'mega-a');
  let finishLaunch!:()=>void;t.launcher=()=>new Promise<void>(resolve=>{finishLaunch=resolve;});
  t.events.chickenSpawn?.({x:80,y:110,z:-30});
  t.events.chickenSpawn?.({x:82,y:111,z:-31});
  t.events.chickenSpawn?.({x:81,y:109,z:-29});
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');
  assert.equal(t.launches.length,1);
  assert.ok(Math.abs(t.launches[0]!.x-81)<0.01);
  assert.equal(f.manager.carePackageTrackingSnapshot()?.instances[0]?.state,'LAUNCHING');

  t.events.chestAppeared?.({x:79,y:64,z:-32});
  const job=f.scheduler.jobs.get('care-package:1000:mega-a');
  assert.equal(job?.state,'QUEUED');
  assert.deepEqual(job?.event.target,{x:79,y:64,z:-32});
  f.tick(1001);assert.equal(job?.state,'QUEUED');

  finishLaunch();await delay(0);
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  assert.equal(f.manager.carePackageTrackingSnapshot()?.instances[0]?.state,'CHEST_DETECTED');
  f.tick(1002);await delay(0);await delay(0);
  assert.equal(f.scheduler.jobs.get('care-package:1000:mega-a')?.state,'COMPLETED');
  f.manager.stop();
});
test('manual launch-pad test uses outward direction and blocks duplicate preparation', async () => {
  const f=fixture();f.tick(0);const t=f.connections[0]!;t.events.spawn();f.tick(1000);f.join(t,'mega-a');
  let finish!:()=>void;t.launcher=()=>new Promise<void>(resolve=>{finish=resolve;});
  const result=f.manager.testLaunchPad('bot-1');
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');
  assert.deepEqual(result.target,{x:128,z:0});
  assert.deepEqual(t.launches,[{x:128,z:0}]);
  assert.throws(()=>f.manager.testLaunchPad('bot-1'),{message:'INVALID_STATE'});
  finish();await delay(0);
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  f.manager.stop();
});
test('performance snapshot tracks completed pathfinding attempts', async () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  f.scheduler.enqueue({ id: 'perf-job', instanceId: 'a', target: { x: 1, y: 64, z: 1 }, type: 'mock', expiresAt: 100000 }, 1000);
  f.tick(1001); await delay(0); await delay(0);
  const perf = f.manager.performanceSnapshot();
  assert.equal(perf.concurrency, 2);
  assert.equal(perf.active, 0);
  assert.equal(perf.bots[0]?.pathAttempts, 1);
  assert.equal(perf.bots[0]?.pathCompleted, 1);
  assert.equal(perf.bots[0]?.pathFailed, 0);
  assert.equal(typeof perf.bots[0]?.lastPathMs, 'number');
  assert.equal(typeof perf.bots[0]?.lastPathQueueMs, 'number');
  f.manager.stop();
});
test('spawn before transfer notification still confirms the same join attempt', () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000);
  t.events.worldReset(); t.events.spawn();
  assert.equal(f.manager.views()[0]?.state, 'JOINING_PIT');
  assert.equal(f.manager.views()[0]?.instanceId, undefined);
  t.events.message('SERVER FOUND! Sending to a!');
  assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE');
  assert.equal(f.manager.views()[0]?.instanceId, 'a');
  f.manager.stop();
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
test('NoPath retries are bounded and retain PATH_NOT_FOUND', async () => {
  const f = fixture(); f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  t.navigation = async () => { const error = new Error('No path to the goal!'); error.name = 'NoPath'; throw error; };
  f.scheduler.enqueue({ id: 'no-path', instanceId: 'a', target: { x: 50, y: 64, z: 50 }, type: 'mock', expiresAt: 100000 }, 1000);

  f.tick(1001); await delay(0);
  assert.equal(f.scheduler.jobs.get('no-path')?.state, 'QUEUED');
  assert.equal(f.scheduler.jobs.get('no-path')?.lastFailure, 'PATH_NOT_FOUND');
  assert.equal(f.scheduler.jobs.get('no-path')?.retryAt, 1101);

  f.tick(1101); await delay(0);
  assert.equal(f.scheduler.jobs.get('no-path')?.state, 'QUEUED');
  assert.equal(f.scheduler.jobs.get('no-path')?.attempts, 2);

  f.tick(1201); await delay(0);
  const job = f.scheduler.jobs.get('no-path')!;
  assert.equal(job.state, 'FAILED');
  assert.equal(job.attempts, 3);
  assert.equal(job.lastFailure, 'PATH_NOT_FOUND');
  assert.equal(job.retryAt, undefined);
  assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE');
  assert.equal(f.manager.performanceSnapshot().bots[0]?.pathFailed, 3);
  f.manager.stop();
});

test('task timeout returns job and does not leave bot WORKING', async () => {
  const f = fixture(1, { onArrive: () => new Promise(() => {}) });
  f.tick(0); const t = f.connections[0]!; t.events.spawn(); f.tick(1000); f.join(t);
  f.scheduler.enqueue({ id: 'job', instanceId: 'a', target: { x: 0, y: 64, z: 0 }, type: 'mock', expiresAt: 100000 }, 1000);
  f.tick(1001); await delay(130);
  assert.equal(f.scheduler.jobs.get('job')?.state, 'QUEUED'); assert.equal(f.scheduler.jobs.get('job')?.lastFailure, 'TASK_TIMEOUT');
  assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE'); f.manager.stop();
});

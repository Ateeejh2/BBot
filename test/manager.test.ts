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
  launcher: (target: Pick<Position,'x'|'z'>, signal: AbortSignal, completion?: 'LAUNCH'|'LANDING') => Promise<void> = async () => {};
  launches: Array<Pick<Position,'x'|'z'>> = [];
  launchCompletions: Array<'LAUNCH'|'LANDING'> = [];
  navigations: Position[] = [];
  serverConnections: Array<{host:string;port:number}> = [];
  serverDisconnects = 0;
  playerCountValue: number | undefined;
  scanEnabled: boolean[] = [];
  constructor(readonly events: TransportEvents) {}
  position() { return { x: 0, y: 64, z: 0 }; }
  async playerCount() { return this.playerCountValue; }
  setPitScanEnabled(enabled: boolean) { this.scanEnabled.push(enabled); }
  chat(command: string) { this.commands.push(command); }
  async connectServer(host: string, port: number) { this.serverConnections.push({host,port}); }
  async disconnectServer() { this.serverDisconnects++; }
  navigate(target: Position, signal: AbortSignal) { this.navigations.push({...target}); return this.navigation(target, signal); }
  launchToward(target: Pick<Position,'x'|'z'>, signal: AbortSignal, completion: 'LAUNCH'|'LANDING' = 'LANDING') { this.launches.push({...target}); this.launchCompletions.push(completion); return this.launcher(target,signal,completion); }
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
test('movement debug waits for a quiet position window then continuously pathfinds', async () => {
  const f = fixture();
  f.manager.setMovementDebug(true);
  f.tick(0);
  const t = f.connections[0]!;
  const targets: Position[] = [];
  const finishes: Array<() => void> = [];
  t.navigation = (next) => new Promise<void>(resolve => { targets.push({...next}); finishes.push(resolve); });
  t.events.spawn();
  await delay(0);
  assert.equal(f.manager.views()[0]?.state,'LOBBY');
  assert.deepEqual(targets,[]);
  f.tick(1000);
  t.events.diagnostic?.('server position correction',{horizontal:0});
  f.tick(2499);
  assert.equal(f.manager.views()[0]?.state,'LOBBY');
  assert.deepEqual(targets,[]);
  f.tick(2500);
  await delay(0);
  assert.equal(f.manager.views()[0]?.state,'PATHFINDING');
  assert.deepEqual(targets[0],{x:6,y:64,z:0});
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
test('Forge API mode can attach a stopped bot without an account assignment', () => {
  const f = fixture(1, new MockTaskHandler(), true);
  f.config.mode = 'live';
  f.config.transport = 'forge';
  assert.equal(f.manager.views()[0]?.accountId, undefined);
  f.manager.connectBot('bot-1');
  assert.equal(f.connections.length, 1);
  assert.equal(f.manager.views()[0]?.state, 'CONNECTING');
  f.manager.stop();
});

test('Pit lobbies at 20 or fewer players never scan and immediately requeue', async () => {
  const low = fixture(1, new MockTaskHandler(), true);
  low.config.mode = 'live';
  low.config.transport = 'forge';
  low.manager.startServer('bot-1', 'mc.example.test', 25565);
  const lowTransport = low.connections[0]!;
  lowTransport.playerCountValue = 20;
  lowTransport.events.spawn();
  low.tick(5000);
  assert.deepEqual(lowTransport.commands, ['/play pit']);
  low.join(lowTransport, 'low-pop');
  await delay(0);
  assert.equal(low.manager.views()[0]?.state, 'RECOVERING');
  assert.equal(low.manager.views()[0]?.instanceId, undefined);
  assert.deepEqual(lowTransport.commands, ['/play pit', '/l']);
  assert.equal(lowTransport.scanEnabled.includes(true), false,
    '20-player lobby must not enable Pit scanning');

  lowTransport.events.worldReset();
  lowTransport.events.spawn();
  low.tick(5001);
  assert.equal(low.manager.views()[0]?.state, 'JOINING_PIT');
  assert.deepEqual(lowTransport.commands, ['/play pit', '/l', '/play pit']);
  low.manager.stop();

  const enough = fixture(1, new MockTaskHandler(), true);
  enough.config.mode = 'live';
  enough.config.transport = 'forge';
  enough.manager.startServer('bot-1', 'mc.example.test', 25565);
  const enoughTransport = enough.connections[0]!;
  enoughTransport.playerCountValue = 21;
  enoughTransport.events.spawn();
  enough.tick(5000);
  enough.join(enoughTransport, 'event-ok');
  await delay(0);
  assert.equal(enough.manager.views()[0]?.state, 'IN_PIT_IDLE');
  assert.equal(enough.manager.views()[0]?.instanceId, 'event-ok');
  assert.deepEqual(enoughTransport.commands, ['/play pit']);
  assert.equal(enoughTransport.scanEnabled.at(-1), true,
    '21-player lobby should enable Pit scanning');
  enough.manager.stop();
});

test('Pit population is polled periodically and a later drop triggers requeue', async () => {
  const f = fixture(1, new MockTaskHandler(), true);
  f.config.mode = 'live';
  f.config.transport = 'forge';
  f.config.pitPopulationCheckMs = 1000;
  f.manager.startServer('bot-1', 'mc.example.test', 25565);
  const t = f.connections[0]!;
  t.playerCountValue = 25;
  t.events.spawn();
  f.tick(5000);
  f.join(t, 'population-watch');
  await delay(0);
  assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE');
  assert.equal(t.scanEnabled.at(-1), true);

  t.playerCountValue = 20;
  f.tick(5999);
  await delay(0);
  assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE');

  f.tick(6000);
  await delay(0);
  assert.equal(f.manager.views()[0]?.state, 'RECOVERING');
  assert.deepEqual(t.commands, ['/play pit', '/l']);
  assert.equal(t.scanEnabled.at(-1), false);
  f.manager.stop();
});

test('Forge Start connects selected server, waits five seconds after spawn, then confirms Pit instance', async () => {
  const f = fixture(1, new MockTaskHandler(), true);
  f.config.mode = 'live';
  f.config.transport = 'forge';

  f.manager.startServer('bot-1', 'mc.example.test', 25565);
  const t = f.connections[0]!;
  await delay(0);
  assert.deepEqual(t.serverConnections, [{ host: 'mc.example.test', port: 25565 }]);
  assert.equal(f.manager.views()[0]?.state, 'CONNECTING');

  t.events.spawn();
  assert.equal(f.manager.views()[0]?.state, 'LOBBY');
  f.tick(4999);
  assert.deepEqual(t.commands, []);
  f.tick(5000);
  assert.deepEqual(t.commands, ['/play pit']);
  assert.equal(f.manager.views()[0]?.state, 'JOINING_PIT');

  f.join(t, 'forge-auto');
  assert.equal(f.manager.views()[0]?.state, 'IN_PIT_IDLE');
  assert.equal(f.manager.views()[0]?.instanceId, 'forge-auto');

  await f.manager.disconnectServer('bot-1');
  assert.equal(t.serverDisconnects, 1);
  assert.equal(t.closed, false);
  assert.equal(f.manager.views()[0]?.state, 'DISCONNECTED');

  // Disconnect ends only the Minecraft server session. The same Forge transport
  // stays alive so a later Start can reconnect without relaunching Forge.
  f.manager.startServer('bot-1', 'mc.example.test', 25565);
  await delay(0);
  assert.deepEqual(t.serverConnections, [
    { host: 'mc.example.test', port: 25565 },
    { host: 'mc.example.test', port: 25565 }
  ]);
  assert.equal(f.connections.length, 1);
  assert.equal(t.closed, false);

  f.manager.stop();
  assert.equal(t.closed, true);
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
test('Limbo notice runs /l, waits two seconds, then rejoins Pit and completes on instance confirmation', () => {
  const f=fixture();
  f.tick(0);const t=f.connections[0]!;t.events.spawn();f.tick(1000);f.join(t,'before-limbo');
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  assert.deepEqual(t.commands,['/play pit']);

  // Player-formatted chat must not trigger Limbo recovery.
  t.events.message('[MVP+] SomePlayer: You were spawned in Limbo.');
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  assert.deepEqual(t.commands,['/play pit']);

  t.events.message('You were spawned in Limbo.');
  assert.equal(f.manager.views()[0]?.state,'RECOVERING');
  assert.equal(f.manager.views()[0]?.instanceId,undefined);
  assert.deepEqual(t.commands,['/play pit','/l']);

  // Duplicate notices do not restart the sequence or send /l twice.
  t.events.message('You were spawned in Limbo.');
  assert.deepEqual(t.commands,['/play pit','/l']);

  // /l transfer may reset the world; this must not fall back to generic Recovery.
  t.events.worldReset();
  t.events.spawn();
  f.tick(2999);
  assert.equal(f.manager.views()[0]?.state,'RECOVERING');
  assert.deepEqual(t.commands,['/play pit','/l']);

  f.tick(3000);
  assert.equal(f.manager.views()[0]?.state,'JOINING_PIT');
  assert.deepEqual(t.commands,['/play pit','/l','/play pit']);

  f.join(t,'after-limbo');
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  assert.equal(f.manager.views()[0]?.instanceId,'after-limbo');
  f.manager.stop();
});
test('Care Package launches, moves toward prediction, then corrects to the real chest', async () => {
  const schedule={refresh:async()=>{},snapshot:()=>({source:'brookeafk.com' as const,sourceUrl:'https://brookeafk.com/',status:'OK' as const,events:[{timestamp:1000}]}),eventsBetween:()=>[{timestamp:1000}]};
  const coordinator=new CarePackageCoordinator(schedule,60_000,180_000,2_000,6,3);
  const f=fixture(1,new MockTaskHandler(),false,coordinator);
  f.tick(0);const t=f.connections[0]!;t.events.spawn();f.tick(1000);f.join(t,'mega-a');
  let finishLaunch!:()=>void;t.launcher=()=>new Promise<void>(resolve=>{finishLaunch=resolve;});
  let predictionStarted=false;
  t.navigation=(_target,signal)=>{
    if(predictionStarted)return Promise.resolve();
    predictionStarted=true;
    return new Promise<void>((_resolve,reject)=>{
      const abort=()=>reject(new Error('prediction corrected'));
      if(signal.aborted){abort();return;}
      signal.addEventListener('abort',abort,{once:true});
    });
  };

  // Schedule time only arms detection. Carrier entities alone must not launch the bot.
  t.events.chickenSpawn?.({x:80,y:110,z:-30});
  t.events.chickenSpawn?.({x:82,y:111,z:-31});
  t.events.chickenSpawn?.({x:81,y:109,z:-29});
  assert.equal(t.launches.length,0);
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');

  // The real event can begin after the scheduled time.
  f.tick(1100);
  t.events.message('MINOR EVENT! CARE PACKAGE in Water Area');
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');
  assert.equal(t.launches.length,1);
  assert.deepEqual(t.launchCompletions,['LANDING']);
  assert.ok(Math.abs(t.launches[0]!.x-81)<0.01);
  assert.equal(f.manager.carePackageTrackingSnapshot()?.instances[0]?.state,'LAUNCHING');
  assert.equal(f.manager.carePackageTrackingSnapshot()?.instances[0]?.area,'Water Area');

  // After landing, move toward the carrier-derived prediction even before the chest exists.
  finishLaunch();await delay(0);await delay(0);
  assert.deepEqual(t.navigations[0],{x:81,y:64,z:-30});
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');

  // Once the real chest appears, cancel the prediction path and immediately correct to it.
  const chest={x:79,y:64,z:-32};
  t.events.chestAppeared?.(chest);
  await delay(0);await delay(0);await delay(0);await delay(0);
  assert.deepEqual(t.navigations.at(-1),chest);
  assert.equal(f.manager.carePackageTrackingSnapshot()?.instances[0]?.state,'CHEST_DETECTED');
  assert.equal(f.scheduler.jobs.get('care-package:1000:mega-a')?.state,'COMPLETED');
  assert.equal(f.manager.performanceSnapshot().bots[0]?.pathFailed,0);
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  f.manager.stop();
});
test('Care Package death cancels the current attempt and immediately retries after respawn settle', async () => {
  const schedule={refresh:async()=>{},snapshot:()=>({source:'brookeafk.com' as const,sourceUrl:'https://brookeafk.com/',status:'OK' as const,events:[{timestamp:1000}]}),eventsBetween:()=>[{timestamp:1000}]};
  const coordinator=new CarePackageCoordinator(schedule,60_000,180_000,2_000,6,3);
  const f=fixture(1,new MockTaskHandler(),false,coordinator);
  f.tick(0);const t=f.connections[0]!;t.events.spawn();f.tick(1000);f.join(t,'mega-a');
  t.launcher=(_target,signal)=>new Promise<void>((_resolve,reject)=>{
    const abort=()=>reject(new Error('Launch cancelled'));
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
  });

  t.events.chickenSpawn?.({x:80,y:110,z:-30});
  t.events.chickenSpawn?.({x:82,y:111,z:-31});
  t.events.chickenSpawn?.({x:81,y:109,z:-29});
  f.tick(1100);t.events.message('MINOR EVENT! CARE PACKAGE in Water Area');
  assert.equal(t.launches.length,1);
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');

  // A player repeating the text is not a death event.
  t.events.message('[MVP+] FakePlayer: DEATH! by [9] Someone VIEW RECAP');
  assert.equal(t.launches.length,1);
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');

  t.events.message('DEATH! by [9] SuperRuzgar2341 VIEW RECAP');
  await delay(0);
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  assert.equal(t.launches.length,1);

  // The actual death respawn can reset/recreate the client world. It must not
  // fall into generic UNKNOWN_RETURN recovery and erase the Care Package retry.
  t.events.worldReset();
  t.events.spawn();
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');

  f.tick(1349);
  assert.equal(t.launches.length,1);
  f.tick(1350);
  assert.equal(t.launches.length,2);
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');
  f.manager.stop();
});

test('Care Package chest disappearance aborts active work and prevents later death retries', async () => {
  const schedule={refresh:async()=>{},snapshot:()=>({source:'brookeafk.com' as const,sourceUrl:'https://brookeafk.com/',status:'OK' as const,events:[{timestamp:1000}]}),eventsBetween:()=>[{timestamp:1000}]};
  const coordinator=new CarePackageCoordinator(schedule,60_000,180_000,2_000,6,3);
  const f=fixture(1,new MockTaskHandler(),false,coordinator);
  f.tick(0);const t=f.connections[0]!;t.events.spawn();f.tick(1000);f.join(t,'mega-a');
  t.launcher=async()=>{};
  let navigationCount=0;
  t.navigation=(_target,signal)=>{
    navigationCount++;
    if(navigationCount===1){
      return new Promise<void>((_resolve,reject)=>{
        const abort=()=>reject(new Error('prediction corrected'));
        if(signal.aborted){abort();return;}
        signal.addEventListener('abort',abort,{once:true});
      });
    }
    return new Promise<void>((_resolve,reject)=>{
      const abort=()=>reject(new Error('event ended'));
      if(signal.aborted){abort();return;}
      signal.addEventListener('abort',abort,{once:true});
    });
  };

  t.events.chickenSpawn?.({x:80,y:110,z:-30});
  t.events.chickenSpawn?.({x:82,y:111,z:-31});
  t.events.chickenSpawn?.({x:81,y:109,z:-29});
  f.tick(1100);t.events.message('MINOR EVENT! CARE PACKAGE in Water Area');
  await delay(0);await delay(0);
  const chest={x:79,y:64,z:-32};
  t.events.chestAppeared?.(chest);
  await delay(0);await delay(0);await delay(0);await delay(0);
  assert.equal(f.manager.views()[0]?.state,'PATHFINDING');
  assert.equal(f.scheduler.jobs.has('care-package:1000:mega-a'),true);

  t.events.chestDisappeared?.(chest);
  await delay(0);await delay(0);
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  assert.equal(f.scheduler.jobs.has('care-package:1000:mega-a'),false);

  const launchesBefore=t.launches.length;
  t.events.message('DEATH! by [88] AnotherPlayer VIEW RECAP');
  f.tick(2000);
  assert.equal(t.launches.length,launchesBefore);
  f.manager.stop();
});

test('manual Care Package test runs launch then same-bot synthetic chest path without a live event', async () => {
  const f=fixture();f.tick(0);const t=f.connections[0]!;t.events.spawn();f.tick(1000);f.join(t,'mega-a');
  let finishLaunch!:()=>void;t.launcher=()=>new Promise<void>(resolve=>{finishLaunch=resolve;});
  const result=f.manager.testCarePackage('bot-1');
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');
  assert.deepEqual(result.launchTarget,{x:128,z:0});
  assert.deepEqual(t.launches,[{x:128,z:0}]);
  assert.deepEqual(t.launchCompletions,['LANDING']);
  assert.throws(()=>f.manager.testCarePackage('bot-1'),{message:'INVALID_STATE'});
  finishLaunch();await delay(0);await delay(0);await delay(0);
  assert.deepEqual(t.navigations.at(-1),{x:4,y:64,z:0});
  assert.equal(f.scheduler.snapshot().some(job=>job.event.type==='care-package-test'),true);
  assert.equal(f.scheduler.snapshot().find(job=>job.event.type==='care-package-test')?.state,'COMPLETED');
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  f.manager.stop();
});

test('manual launch-pad test uses outward direction and blocks duplicate preparation', async () => {
  const f=fixture();f.tick(0);const t=f.connections[0]!;t.events.spawn();f.tick(1000);f.join(t,'mega-a');
  let finish!:()=>void;t.launcher=()=>new Promise<void>(resolve=>{finish=resolve;});
  const result=f.manager.testLaunchPad('bot-1');
  assert.equal(f.manager.views()[0]?.state,'PREPARING_EVENT');
  assert.deepEqual(result.target,{x:128,z:0});
  assert.deepEqual(t.launches,[{x:128,z:0}]);
  assert.deepEqual(t.launchCompletions,['LANDING']);
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
test('verified Pit locraw confirms membership when spawn signal is missed', () => {
  const f = fixture();
  f.tick(0);
  const t = f.connections[0]!;
  t.events.spawn();
  f.tick(1000);
  assert.equal(f.manager.views()[0]?.state,'JOINING_PIT');
  assert.deepEqual(t.commands,['/play pit']);

  t.events.message('SERVER FOUND! Sending to mega-fallback!');
  assert.equal(f.manager.views()[0]?.state,'JOINING_PIT');
  assert.deepEqual(t.commands,['/play pit','/locraw']);

  t.events.message('{"server":"mega-fallback","gametype":"PIT","mode":"PIT","map":"The Pit"}');
  assert.equal(f.manager.views()[0]?.state,'IN_PIT_IDLE');
  assert.equal(f.manager.views()[0]?.instanceId,'mega-fallback');
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

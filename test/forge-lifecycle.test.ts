import test from 'node:test';
import assert from 'node:assert/strict';
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

class ForgeLifecycleTransport implements BotTransport {
  private current: Position = { x: 0, y: 64, z: 0 };
  connectCalls = 0;
  disconnectCalls = 0;
  closeCalls = 0;
  failNextConnect = false;
  omitTransferNotice = false;
  lastServer?: { host: string; port: number };

  constructor(private events: TransportEvents) {}

  position(): Position { return { ...this.current }; }
  ping(): number { return 42; }

  async connectServer(host: string, port: number): Promise<void> {
    this.connectCalls++;
    this.lastServer = { host, port };
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error('SERVER_CONNECT_FAILED');
    }
  }

  async disconnectServer(): Promise<void> {
    this.disconnectCalls++;
    this.events.serverDisconnected?.();
  }

  spawnNow(): void {
    this.events.spawn();
  }

  chat(command: string): void {
    if(command==='/locraw'){
      this.events.message('{"server":"mega-regression","gametype":"PIT","mode":"PIT","map":"The Pit"}');
      return;
    }
    if (command !== '/play pit') return;
    if(!this.omitTransferNotice)this.events.message('SERVER FOUND! Sending to mega-regression!');
    this.events.worldReset();
    this.events.spawn();
  }

  async navigate(target: Position): Promise<void> {
    this.current = { ...target };
  }

  stopPath(): void {}
  close(): void { this.closeCalls++; }
}

function createForgeManager() {
  let now = 1_000;
  let factoryCalls = 0;
  let transport: ForgeLifecycleTransport | undefined;
  const config = loadConfig({
    MODE: 'live',
    BBOT_TRANSPORT: 'forge',
    BOT_COUNT: '1',
    API_ENABLED: 'true',
    API_ORIGIN: 'http://localhost:5173',
    SERVER_HOST: 'play.example.test',
    SERVER_PORT: '25565',
    CONNECT_TIMEOUT_MS: '10000'
  });
  const manager = new BotManager(
    config,
    (_index, events) => {
      factoryCalls++;
      transport = new ForgeLifecycleTransport(events);
      return transport;
    },
    new InstanceRegistry(),
    new Scheduler(3, 100, 100),
    new PathfindingController(1, 1000),
    new MockTaskHandler(),
    new Logger('error'),
    () => now,
    () => 0.5
  );
  return {
    manager,
    get transport() { return transport; },
    get factoryCalls() { return factoryCalls; },
    setNow(value: number) { now = value; }
  };
}

test('Forge server Disconnect keeps the client transport alive and Start reuses it', async () => {
  const fixture = createForgeManager();
  const { manager } = fixture;
  try {
    manager.startServer('bot-1', 'play.example.test', 25565);
    const transport = fixture.transport;
    assert.ok(transport);
    assert.equal(fixture.factoryCalls, 1);
    assert.equal(manager.views()[0]?.state, 'CONNECTING');
    assert.deepEqual(transport.lastServer, { host: 'play.example.test', port: 25565 });

    transport.spawnNow();
    assert.equal(manager.views()[0]?.state, 'LOBBY');
    fixture.setNow(5_999);
    manager.tick();
    assert.equal(manager.views()[0]?.state, 'LOBBY');
    fixture.setNow(6_000);
    manager.tick();
    assert.equal(manager.views()[0]?.state, 'IN_PIT_IDLE');
    assert.equal(manager.views()[0]?.instanceId, 'mega-regression');

    await manager.disconnectServer('bot-1');
    assert.equal(manager.views()[0]?.state, 'DISCONNECTED');
    assert.equal(manager.views()[0]?.instanceId, undefined);
    assert.equal(transport.disconnectCalls, 1);
    assert.equal(transport.closeCalls, 0);
    await assert.rejects(manager.disconnectServer('bot-1'), /INVALID_STATE/);

    fixture.setNow(7_000);
    manager.startServer('bot-1', 'play.example.test', 25565);
    assert.equal(manager.views()[0]?.state, 'CONNECTING');
    assert.equal(fixture.factoryCalls, 1, 'Disconnect must not create a second Forge transport');
    assert.equal(fixture.transport, transport);
    assert.equal(transport.connectCalls, 2);
    assert.throws(() => manager.startServer('bot-1', 'play.example.test', 25565), /INVALID_STATE/);

    transport.spawnNow();
    assert.equal(manager.views()[0]?.state, 'LOBBY');
    fixture.setNow(12_000);
    manager.tick();
    assert.equal(manager.views()[0]?.state, 'IN_PIT_IDLE');

    await manager.disconnectServer('bot-1');
    assert.equal(manager.views()[0]?.state, 'DISCONNECTED');
    assert.equal(transport.closeCalls, 0);
  } finally {
    manager.stop();
  }
  assert.equal(fixture.transport?.closeCalls, 1, 'manager stop/Quit path may close the retained bridge transport');
});

test('Forge connection timeout pauses instead of silently reconnecting forever', () => {
  const fixture = createForgeManager();
  const { manager } = fixture;
  try {
    manager.startServer('bot-1', 'play.example.test', 25565);
    const first = fixture.transport;
    assert.ok(first);
    assert.equal(manager.views()[0]?.state, 'CONNECTING');
    assert.equal(fixture.factoryCalls, 1);

    fixture.setNow(11_000);
    manager.tick();
    assert.equal(manager.views()[0]?.state, 'DISCONNECTED');
    assert.equal(first.closeCalls, 1);

    fixture.setNow(60_000);
    manager.tick();
    assert.equal(manager.views()[0]?.state, 'DISCONNECTED');
    assert.equal(fixture.factoryCalls, 1, 'timed-out Forge Start must wait for an explicit retry');

    manager.startServer('bot-1', 'play.example.test', 25565);
    assert.equal(manager.views()[0]?.state, 'CONNECTING');
    assert.equal(fixture.factoryCalls, 2);
  } finally {
    manager.stop();
  }
});

test('Forge Pit join falls back to locraw when transfer notice is missed', () => {
  const fixture=createForgeManager();
  const {manager}=fixture;
  try{
    manager.startServer('bot-1','play.example.test',25565);
    const transport=fixture.transport;
    assert.ok(transport);
    transport.omitTransferNotice=true;
    transport.spawnNow();
    assert.equal(manager.views()[0]?.state,'LOBBY');

    fixture.setNow(6_000);
    manager.tick();
    assert.equal(manager.views()[0]?.state,'IN_PIT_IDLE');
    assert.equal(manager.views()[0]?.instanceId,'mega-regression');
  }finally{
    manager.stop();
  }
});

test('late transfer notice after locraw confirmation does not restart Pit joining', () => {
  const fixture=createForgeManager();
  const {manager}=fixture;
  try{
    manager.startServer('bot-1','play.example.test',25565);
    const transport=fixture.transport;
    assert.ok(transport);
    transport.omitTransferNotice=true;
    transport.spawnNow();
    fixture.setNow(6_000);
    manager.tick();
    assert.equal(manager.views()[0]?.state,'IN_PIT_IDLE');
    assert.equal(manager.views()[0]?.instanceId,'mega-regression');

    transport['events'].message('SERVER FOUND! Sending to mega-regression!');
    assert.equal(manager.views()[0]?.state,'IN_PIT_IDLE');
    assert.equal(manager.views()[0]?.instanceId,'mega-regression');
  }finally{
    manager.stop();
  }
});

test('Forge reconnect failure returns to DISCONNECTED without destroying the retained transport', async () => {
  const fixture = createForgeManager();
  const { manager } = fixture;
  try {
    manager.startServer('bot-1', 'play.example.test', 25565);
    const transport = fixture.transport;
    assert.ok(transport);
    transport.spawnNow();

    fixture.setNow(6_000);
    manager.tick();
    assert.equal(manager.views()[0]?.state, 'IN_PIT_IDLE');
    await manager.disconnectServer('bot-1');
    assert.equal(manager.views()[0]?.state, 'DISCONNECTED');

    transport.failNextConnect = true;
    fixture.setNow(7_000);
    manager.startServer('bot-1', 'bad.example.test', 25565);
    assert.equal(manager.views()[0]?.state, 'CONNECTING');
    await delay(0);
    assert.equal(manager.views()[0]?.state, 'DISCONNECTED');
    assert.equal(transport.closeCalls, 0);
    assert.equal(fixture.factoryCalls, 1);

    manager.startServer('bot-1', 'play.example.test', 25565);
    assert.equal(manager.views()[0]?.state, 'CONNECTING');
    assert.equal(transport.connectCalls, 3);
    assert.equal(fixture.factoryCalls, 1);
  } finally {
    manager.stop();
  }
});

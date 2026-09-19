import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstance } from '../src/instances/parser.js';
import { StateMachine, Generation } from '../src/core/state.js';
import { InstanceRegistry } from '../src/instances/registry.js';
import { DistributionManager } from '../src/instances/distribution.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { backoff } from '../src/recovery/backoff.js';
import { MockEventProvider, parseEventFeedV1 } from '../src/events/provider.js';
import { loadConfig } from '../src/config/index.js';
import { UnknownReturnClassifier, type BotView, type GameEvent } from '../src/core/types.js';
import { CarePackageCoordinator, parseCarePackageAnnouncement } from '../src/events/care-package.js';
const event = (id = 'e1'): GameEvent => ({ id, instanceId: 'mega10c', target: { x: 1, y: 64, z: 2 }, type: 'mock', expiresAt: 100000 });
const bot = (id: string, x = 0): BotView => ({ id, accountLabel: id, state: 'IN_PIT_IDLE', instanceId: 'mega10c', generation: 0, position: { x, y: 64, z: 2 } });
test('transfer parser accepts case/format variations and arbitrary instance prefixes', () => {
  for (const [text, expected] of [
    ['SERVER FOUND! Sending to mega10c!', 'mega10c'],
    ['server found! sending to MINI-2.A!', 'mini-2.a'],
    [' §aSERVER FOUND! §rSending to zone_ABC! ', 'zone_abc'],
    ['SERVER  FOUND!\tSending to NewInstance99!', 'newinstance99']
  ]) assert.equal(parseInstance(text!), expected);
});
test('transfer parser rejects chat spoofing, partial/malformed messages', () => {
  for (const value of ['<player> SERVER FOUND! Sending to mega10c!', 'Sending to mega10c!', 'SERVER FOUND! Sending to !', 'SERVER FOUND! Sending to mega10c', 'SERVER FOUND! Sending to a! extra', `SERVER FOUND! Sending to ${'a'.repeat(129)}!`]) assert.equal(parseInstance(value), undefined);
});
test('state machine rejects invalid transitions, accepts full job/recovery lifecycle', () => {
  const machine = new StateMachine();
  assert.throws(() => machine.transition('WORKING'));
  for (const state of ['CONNECTING', 'LOBBY', 'JOINING_PIT', 'IN_PIT_IDLE', 'PREPARING_EVENT', 'IN_PIT_IDLE', 'PATHFINDING', 'WORKING', 'RECOVERING', 'JOINING_PIT', 'DISCONNECTED'] as const) machine.transition(state);
  assert.equal(machine.state, 'DISCONNECTED');
});
test('generation invalidates stale callbacks', () => { const g = new Generation(); const token = g.current; g.invalidate(); assert.equal(g.isCurrent(token), false); });
test('registry discovers, ages, reactivates and keeps firstSeen', () => {
  const r = new InstanceRegistry(); r.join('NEW-1', 'b1', 10); r.leave('b1', 20, 'AFK');
  r.maintain(200, 100, 1000); assert.equal(r.records.get('new-1')?.status, 'SUSPECT');
  r.maintain(2000, 100, 1000); assert.equal(r.records.get('new-1')?.status, 'INACTIVE');
  r.join('new-1', 'b2', 3000); assert.equal(r.records.get('new-1')?.firstSeen, 10); assert.equal(r.records.get('new-1')?.status, 'ACTIVE');
});
test('single abnormal return is not an instance crash; distinct correlated bots mark suspect', () => {
  const r = new InstanceRegistry(); r.join('a', 'b1', 0); r.join('a', 'b2', 0);
  r.leave('b1', 100, 'UNKNOWN_RETURN'); assert.equal(r.records.get('a')?.status, 'ACTIVE');
  r.leave('b2', 200, 'UNKNOWN_RETURN'); assert.equal(r.records.get('a')?.status, 'SUSPECT');
  r.heartbeat('a', 300); assert.equal(r.records.get('a')?.status, 'SUSPECT');
});
test('AFK and planned departures do not contribute to crash correlation', () => {
  const r = new InstanceRegistry(); r.join('a', 'b1', 0); r.join('a', 'b2', 0);
  r.leave('b1', 1, 'AFK'); r.leave('b2', 2, 'PLANNED'); assert.equal(r.records.get('a')?.status, 'ACTIVE');
  assert.equal(new UnknownReturnClassifier().classify('any guessed AFK text'), undefined);
});
test('registry memory cap evicts only inactive empty records', () => {
  const r = new InstanceRegistry(2); r.observe('a', 0); r.join('b', 'bot', 0);
  assert.throws(() => r.observe('c', 1)); r.maintain(100, 10, 20); r.observe('c', 101);
  assert.equal(r.records.size, 2); assert.ok(r.records.has('b')); assert.ok(!r.records.has('a'));
});
test('distribution chooses crowded idle bot and stops at bounded attempt budget', () => {
  const r = new InstanceRegistry(); const bots = [bot('b1'), bot('b2'), bot('b3')];
  for (const b of bots) r.join('mega10c', b.id, 0); r.observe('empty', 0);
  const d = new DistributionManager(1, 100);
  assert.equal(d.choose(bots, r, 0)?.id, 'b1'); d.recordAttempt('b1', 0);
  assert.equal(d.choose(bots, r, 100000)?.id, 'b2');
  d.recordAttempt('b2', 0); d.recordAttempt('b3', 0); assert.equal(d.choose(bots, r, 100000), undefined);
});
test('more instances than bots is valid; balanced assignment causes no reroll', () => {
  const r = new InstanceRegistry(); r.join('mega10c', 'b1', 0);
  for (let i = 0; i < 100; i++) r.observe(`new${i}`, 0);
  assert.equal(new DistributionManager(2, 10).choose([bot('b1')], r, 0), undefined);
});
test('scheduler chooses nearest eligible same-instance bot without double assignment', () => {
  const s = new Scheduler(); s.enqueue(event(), 0); s.enqueue(event('e2'), 0);
  const busy = { ...bot('busy', 1), state: 'WORKING' as const };
  const wrong = { ...bot('wrong', 1), instanceId: 'other' };
  const assigned = s.assign([bot('far', 20), bot('near', 1), busy, wrong], 1);
  assert.deepEqual(assigned.map(a => a.bot.id), ['near', 'far']); assert.equal(s.assign([bot('near')], 2).length, 0);
});
test('scheduler can pin a queued job to a specific eligible bot', () => {
  const s = new Scheduler(); s.enqueue(event(),0);
  const pinned = bot('pinned',20);
  const nearer = bot('nearer',1);
  const assignment = s.assignTo('e1',pinned,1);
  assert.equal(assignment?.bot.id,'pinned');
  assert.equal(s.jobs.get('e1')?.botId,'pinned');
  assert.equal(s.assign([nearer],2).length,0);
});

test('job return records reason and retry time; stale completion cannot finish reassigned job', () => {
  const s = new Scheduler(3, 100, 10); s.enqueue(event(), 0);
  const a = s.assign([bot('a')], 1)[0]!; const lease = a.job.lease;
  assert.ok(s.release('e1', 'a', lease, 2, 'PATH_NOT_FOUND'));
  assert.equal(s.jobs.get('e1')?.lastFailure, 'PATH_NOT_FOUND');
  assert.equal(s.jobs.get('e1')?.lastFailureAt, 2);
  assert.equal(s.jobs.get('e1')?.retryAt, 12);
  assert.equal(s.assign([bot('b')], 3).length, 0);
  const b = s.assign([bot('b')], 12)[0]!;
  assert.equal(s.jobs.get('e1')?.retryAt, undefined);
  assert.equal(s.complete('e1', 'a', lease, 13), false);
  assert.ok(s.complete('e1', 'b', b.job.lease, 14)); assert.equal(s.jobs.get('e1')?.state, 'COMPLETED');
  assert.equal(s.enqueue(event(), 15), false);
});
test('job attempts are bounded and terminal failures keep a reason', () => {
  const s = new Scheduler(1); s.enqueue(event(), 0); const a = s.assign([bot('a')], 1)[0]!;
  s.release('e1', 'a', a.job.lease, 2, 'PATH_TIMEOUT');
  assert.equal(s.attemptLimit, 1);
  assert.equal(s.jobs.get('e1')?.state, 'FAILED');
  assert.equal(s.jobs.get('e1')?.lastFailure, 'PATH_TIMEOUT');
  assert.equal(s.jobs.get('e1')?.retryAt, undefined);
  s.enqueue(event('e2'), 0); s.assign([bot('a')], 1); assert.equal(s.expire(100001).length, 1);
  assert.equal(s.jobs.get('e2')?.state, 'EXPIRED');
  assert.equal(s.jobs.get('e2')?.lastFailure, 'JOB_EXPIRED');
});
test('snapshot restoration requeues interrupted jobs with a new lease', () => {
  const s = new Scheduler(); s.enqueue(event(), 0); s.assign([bot('a')], 1);
  const restored = new Scheduler(); restored.restore(s.snapshot(), 10);
  assert.equal(restored.jobs.get('e1')?.state, 'QUEUED'); assert.equal(restored.jobs.get('e1')?.botId, undefined);
  assert.equal(restored.jobs.get('e1')?.lease, 2);
});
test('backoff grows, caps and distributes attempts with jitter', () => {
  const c = { baseMs: 1000, maxMs: 8000, jitter: 0.5 };
  assert.equal(backoff(0, c, () => 0), 500); assert.equal(backoff(1, c, () => 1), 2000);
  assert.equal(backoff(10000, c, () => 1), 8000); assert.equal(backoff(10000, c, () => 0), 4000);
});
test('MockEventProvider filters expiry and does not share mutable results', async () => {
  const provider = new MockEventProvider([event(), { ...event('old'), expiresAt: 1 }], () => 2);
  const first = await provider.fetchEvents(); assert.equal(first.length, 1); first[0]!.target.x = 999;
  assert.equal((await provider.fetchEvents())[0]!.target.x, 1);
  await assert.rejects(provider.fetchEvents(AbortSignal.abort()));
});
test('external event feed V1 is strict and cloned', () => {
  const feed = { version: 1 as const, events: [event()] };
  const parsed = parseEventFeedV1(feed);
  assert.deepEqual(parsed, feed.events);
  parsed[0]!.target.x = 999;
  assert.equal(feed.events[0]!.target.x, 1);
  for (const invalid of [
    [event()],
    { version: 2, events: [event()] },
    { version: 1, events: [{}] },
    { version: 1, events: [event()], extra: true }
  ]) assert.throws(() => parseEventFeedV1(invalid));
});
test('Care Package coordinator waits for the live announcement, then clusters and expires from actual start', () => {
  const schedule = {
    refresh: async () => {},
    snapshot: () => ({source:'brookeafk.com' as const,sourceUrl:'https://brookeafk.com/',status:'OK' as const,
      events:[{timestamp:10_000}]}),
    eventsBetween: () => [{timestamp:10_000}]
  };
  const coordinator = new CarePackageCoordinator(schedule,60_000,180_000,2_000,6,3);
  assert.deepEqual(parseCarePackageAnnouncement('§eMINOR EVENT! §6CARE PACKAGE in Water Area'),{area:'Water Area'});
  assert.equal(parseCarePackageAnnouncement('MINOR EVENT! KOTL in Water Area'),undefined);

  // Chickens can be buffered around the transition, but cannot trigger before the server announces the event.
  assert.equal(coordinator.observeChicken('Mega-A',{x:100,y:110,z:-50},9_900),undefined);
  assert.equal(coordinator.observeChicken('Mega-A',{x:102,y:111,z:-49},9_950),undefined);
  assert.equal(coordinator.observeChicken('Mega-A',{x:101,y:109,z:-51},10_000),undefined);

  const started=coordinator.observeAnnouncement('Mega-A','MINOR EVENT! CARE PACKAGE in Water Area',10_100);
  assert.equal(started?.instanceId,'mega-a');
  assert.equal(started?.area,'Water Area');
  assert.ok(started?.target && Math.abs(started.target.x-101)<0.01 && Math.abs(started.target.z+50)<0.01);
  coordinator.markLaunch('Mega-A',10_000,'LAUNCHING');
  assert.equal(coordinator.trackingSnapshot(10_101).instances[0]?.state,'LAUNCHING');

  const job=coordinator.observeChest('Mega-A',{x:99,y:64,z:-52},10_200);
  assert.equal(job?.id,'care-package:10000:mega-a');
  assert.equal(job?.type,'care-package');
  assert.deepEqual(job?.target,{x:99,y:64,z:-52});
  assert.equal(job?.expiresAt,190_100);
  assert.equal(job?.metadata?.startedAt,10_100);
  assert.equal(job?.metadata?.area,'Water Area');
  assert.equal(coordinator.observeChest('Mega-A',{x:100,y:64,z:-52},10_210),undefined);
  assert.equal(coordinator.trackingSnapshot(10_210).instances[0]?.state,'CHEST_DETECTED');
});
test('configuration defaults are safe and malformed values fail closed', () => {
  assert.equal(loadConfig({}).mode, 'mock'); assert.equal(loadConfig({}).count, 1); assert.equal(loadConfig({}).pathConcurrency, 2);
  assert.equal(loadConfig({}).version, '1.8.9'); assert.equal(loadConfig({ MC_VERSION: '' }).version, '1.8.9');
  assert.equal(loadConfig({ MC_VERSION: '1.16.5' }).version, '1.16.5');
  assert.equal(loadConfig({}).transferMessageChannel, 'system');
  assert.equal(loadConfig({}).eventProviderUrl, undefined);
  assert.equal(loadConfig({ EVENT_PROVIDER_URL: 'https://events.example.test/feed?region=jp' }).eventProviderUrl, 'https://events.example.test/feed?region=jp');
  assert.equal(loadConfig({ EVENT_PROVIDER_URL: 'http://127.0.0.1:8080/feed' }).eventProviderUrl, 'http://127.0.0.1:8080/feed');
  for (const env of [{ BOT_COUNT: '21' }, { BOT_COUNT: '1.5' }, { PATH_CONCURRENCY: '0' }, { DEBUG: 'yes' }, { MODE: 'production' }, { LOBBY_COMMAND: '/server pit' }, { TRANSFER_MESSAGE_CHANNEL: 'title' },
    { EVENT_PROVIDER_URL: 'http://events.example.test/feed' }, { EVENT_PROVIDER_URL: 'https://user:pass@events.example.test/feed' }, { EVENT_PROVIDER_URL: 'https://events.example.test/feed#secret' }]) assert.throws(() => loadConfig(env));
});

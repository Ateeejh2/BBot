import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpEventProvider, parseEventFeedV1 } from '../src/events/provider.js';
import { BrookeCarePackageSchedule } from '../src/events/brooke.js';
import { JsonStore } from '../src/core/store.js';
import { Logger } from '../src/logging/logger.js';
const options = { timeoutMs: 50, retries: 0, minIntervalMs: 1, maxBytes: 1000, maxRetryMs: 1 };
const url = new URL('https://example.invalid/events');
test('Brooke schedule returns the nearest five future Care Packages and keeps last good data', async () => {
  let now = 1_000_000;
  let fail = false;
  const feed = [
    { event:'Care Package', timestamp:900_000, type:'minor' },
    { event:'Auction', timestamp:1_010_000, type:'minor' },
    { event:'Care Package', timestamp:1_060_000, type:'minor' },
    { event:'Care Package', timestamp:1_020_000, type:'minor' },
    { event:'Care Package', timestamp:1_050_000, type:'minor' },
    { event:'Care Package', timestamp:1_030_000, type:'minor' },
    { event:'Care Package', timestamp:1_040_000, type:'minor' },
    { event:'Care Package', timestamp:1_070_000, type:'minor' }
  ];
  const schedule = new BrookeCarePackageSchedule((async () => {
    if (fail) throw new Error('offline');
    return new Response(JSON.stringify(feed));
  }) as typeof fetch, () => now);
  await schedule.refresh();
  assert.deepEqual(schedule.snapshot().events.map(event => event.timestamp),
    [1_020_000,1_030_000,1_040_000,1_050_000,1_060_000]);
  assert.equal(schedule.snapshot().status,'OK');

  fail = true; now += 61_000;
  await assert.rejects(schedule.refresh());
  assert.equal(schedule.snapshot().events.length,5);
  assert.equal(schedule.snapshot().status,'OK');
  now += 60_000;
  assert.equal(schedule.snapshot().status,'STALE');
});

test('HTTP provider accepts canonical event feed V1', async () => {
  const expiresAt = Date.now() + 60_000;
  const body = JSON.stringify({ version: 1, events: [{
    id: 'web-event-1', instanceId: 'Mega-A', type: 'care-package',
    target: { x: 10, y: 64, z: -5 }, expiresAt
  }] });
  const provider = new HttpEventProvider(url, parseEventFeedV1, options, (async () => new Response(body)) as typeof fetch);
  const events = await provider.fetchEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.id, 'web-event-1');
  assert.equal(events[0]?.instanceId, 'Mega-A');
  assert.deepEqual(events[0]?.target, { x: 10, y: 64, z: -5 });
});

test('HTTP provider validates parse output and rejects oversized/invalid bodies', async () => {
  for (const body of ['invalid-json', '[{}]', 'x'.repeat(1001)]) {
    const provider = new HttpEventProvider(url, value => value as never, options, (async () => new Response(body)) as typeof fetch);
    await assert.rejects(provider.fetchEvents());
  }
});
test('HTTP provider retries 429 and shares one request across concurrent fetches', async () => {
  let calls = 0;
  const provider = new HttpEventProvider(url, value => value as never, { ...options, retries: 1 }, (async () => {
    calls++; return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : new Response('[]');
  }) as typeof fetch);
  const [a, b] = await Promise.all([provider.fetchEvents(), provider.fetchEvents()]);
  assert.deepEqual(a, []); assert.deepEqual(b, []); assert.equal(calls, 2);
});
test('HTTP timeout aborts request; 400 does not retry', async () => {
  const provider = new HttpEventProvider(url, () => [], options, ((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  })) as typeof fetch);
  await assert.rejects(provider.fetchEvents());
  let calls = 0;
  const invalid = new HttpEventProvider(url, () => [], { ...options, retries: 2 }, (async () => { calls++; return new Response('', { status: 400 }); }) as typeof fetch);
  await assert.rejects(invalid.fetchEvents()); assert.equal(calls, 1);
});
test('HTTP caller cancellation interrupts retry-after wait', async () => {
  const ac = new AbortController();
  const provider = new HttpEventProvider(url, () => [], { ...options, retries: 1 }, (async () => {
    setTimeout(() => ac.abort(), 5); return new Response('', { status: 429, headers: { 'retry-after': '3600' } });
  }) as typeof fetch);
  await assert.rejects(provider.fetchEvents(ac.signal));
});
test('snapshot atomic replacement, backup restore and corruption fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bbot-store-'));
  try {
    const store = new JsonStore(dir, 'test'); assert.equal(await store.load(), undefined);
    const snapshot = { version: 1 as const, jobs: [], instances: [] };
    await store.save(snapshot); await store.save(snapshot); assert.deepEqual(await store.load(), snapshot);
    await writeFile(join(dir, 'test-state.json'), 'broken'); assert.deepEqual(await store.load(), snapshot);
    await writeFile(join(dir, 'test-state.json.bak'), 'broken'); await assert.rejects(store.load());
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('structured file logs rotate and remove account credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bbot-logs-'));
  const logger = new Logger('error', dir, 500, 2, ['private-account@example.invalid']);
  try {
    for (let i = 0; i < 5; i++) logger.log('error', 'test', { username: 'secret-user', token: 'secret-token', detail: 'private-account@example.invalid' });
    const files = await readdir(dir); assert.ok(files.length <= 3);
    for (const file of files) {
      const body = await readFile(join(dir, file), 'utf8');
      assert.ok(!body.includes('private-account')); assert.ok(!body.includes('secret-user')); assert.ok(!body.includes('secret-token'));
      for (const line of body.trim().split('\n')) assert.ok(JSON.parse(line).timestamp);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

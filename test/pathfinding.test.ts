import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PathfindingController, PathfindingError } from '../src/pathfinding/controller.js';
test('path queue enforces concurrency including replanning lifetime', async () => {
  const c = new PathfindingController(2, 1000); const signal = new AbortController().signal;
  let active = 0; let peak = 0;
  await Promise.all(Array.from({ length: 20 }, (_, i) => c.submit(`${i}`, signal, async () => {
    active++; peak = Math.max(peak, active); await delay(2);
  }, () => { active--; })));
  assert.equal(peak, 2); assert.equal(c.active, 0); assert.equal(c.queued, 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});
test('queued cancellation never starts navigation', async () => {
  const c = new PathfindingController(1, 1000); const a = new AbortController(); const b = new AbortController();
  const first = c.submit('a', a.signal, () => new Promise(() => {}), () => {});
  let started = false; const second = c.submit('b', b.signal, async () => { started = true; }, () => {});
  const rejected = assert.rejects(second); b.abort(); await rejected;
  const rejectedFirst = assert.rejects(first); a.abort(); await rejectedFirst;
  assert.equal(started, false); assert.equal(c.active, 0); assert.equal(c.queued, 0);
});
test('timeout is classified and releases slot; late resolve cannot disturb new operation', async () => {
  const c = new PathfindingController(1, 10); let late!: () => void; let stops = 0;
  const p = c.submit('old', new AbortController().signal, () => new Promise(resolve => { late = resolve; }), () => { stops++; });
  await assert.rejects(p, (error: unknown) => error instanceof PathfindingError && error.code === 'PATH_TIMEOUT');
  await c.submit('new', new AbortController().signal, async () => {}, () => { stops++; });
  late(); await delay(1); assert.equal(stops, 2); assert.equal(c.active, 0);
});
test('NoPath from mineflayer-pathfinder is classified without exposing raw errors', async () => {
  const c = new PathfindingController(1, 1000);
  const error = new Error('No path to the goal!'); error.name = 'NoPath';
  await assert.rejects(c.submit('no-path', new AbortController().signal, async () => { throw error; }, () => {}),
    (value: unknown) => value instanceof PathfindingError && value.code === 'PATH_NOT_FOUND');
});

test('repeated cancellation leaves no abort listeners', async () => {
  const c = new PathfindingController(2, 1000);
  for (let i = 0; i < 200; i++) {
    const ac = new AbortController();
    const p = c.submit(String(i), ac.signal, () => new Promise(() => {}), () => {});
    const rejection = assert.rejects(p); ac.abort(); await rejection;
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  }
  assert.equal(c.active, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PitMapCache } from '../src/pathfinding/map-cache.js';

test('Pit map cache allows old and new weekly maps to coexist across instances', () => {
  const cache = new PitMapCache<{name:string}>(7 * 24 * 60 * 60 * 1000);
  cache.bind('Castle-1', 'terrain:castle-v1', 1000);
  cache.bind('Coral-2', 'terrain:coral-v1', 1001);
  cache.setGraph('terrain:castle-v1', {name:'castle'}, 1100);
  cache.setGraph('terrain:coral-v1', {name:'coral'}, 1101);

  assert.equal(cache.graphForInstance('Castle-1')?.name, 'castle');
  assert.equal(cache.graphForInstance('Coral-2')?.name, 'coral');
  assert.deepEqual(cache.snapshot(1200).map(value => value.fingerprint).sort(),
    ['terrain:castle-v1','terrain:coral-v1']);
});

test('rebinding one instance to the new map does not evict the old generation used elsewhere', () => {
  const cache = new PitMapCache<{name:string}>();
  cache.bind('mega-a', 'terrain:castle-v1', 1000);
  cache.bind('mega-b', 'terrain:castle-v1', 1000);
  cache.setGraph('terrain:castle-v1', {name:'castle'}, 1000);
  cache.setGraph('terrain:coral-v1', {name:'coral'}, 1000);

  cache.bind('mega-a', 'terrain:coral-v1', 2000);
  assert.equal(cache.graphForInstance('mega-a')?.name, 'coral');
  assert.equal(cache.graphForInstance('mega-b')?.name, 'castle');

  const snapshot = cache.snapshot(2000);
  assert.deepEqual(snapshot.find(value => value.fingerprint === 'terrain:castle-v1')?.instances, ['mega-b']);
  assert.deepEqual(snapshot.find(value => value.fingerprint === 'terrain:coral-v1')?.instances, ['mega-a']);
});

test('weekly refresh is due without disabling a still-valid cached graph', () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const cache = new PitMapCache<{version:number}>(week);
  cache.bind('mega-a', 'terrain:castle-v1', 0);
  cache.setGraph('terrain:castle-v1', {version:1}, 0);

  assert.equal(cache.refreshDue('mega-a', week - 1), false);
  assert.equal(cache.refreshDue('mega-a', week), true);
  assert.equal(cache.graphForInstance('mega-a')?.version, 1);
});

test('terrain mismatch invalidates only the affected fingerprint generation', () => {
  const cache = new PitMapCache<{name:string}>();
  cache.bind('mega-a', 'terrain:castle-v1', 0);
  cache.bind('mega-b', 'terrain:coral-v1', 0);
  cache.setGraph('terrain:castle-v1', {name:'castle'}, 0);
  cache.setGraph('terrain:coral-v1', {name:'coral'}, 0);

  cache.invalidateInstance('mega-a');
  assert.equal(cache.graphForInstance('mega-a'), undefined);
  assert.equal(cache.refreshDue('mega-a', 1), true);
  assert.equal(cache.graphForInstance('mega-b')?.name, 'coral');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMineflayerTransport } from '../src/bot/mineflayer.js';

test('mineflayer transport module loads under Node ESM', () => {
  assert.equal(typeof createMineflayerTransport, 'function');
});


test('live movement executor uses controls without pathfinder execution or direct motion rewrites', async () => {
  const source = await readFile('src/bot/mineflayer.ts','utf8');
  assert.doesNotMatch(source,/pathfinder\.goto\s*\(/);
  assert.doesNotMatch(source,/bot\.entity\.velocity\.[xyz]\s*=/);
  assert.doesNotMatch(source,/bot\.entity\.position\.[xyz]\s*=/);
  assert.doesNotMatch(source,/setControlState\(['"]sprint['"],\s*true\)/);
  assert.match(source,/setControlState\(['"]forward['"],\s*true\)/);
  assert.match(source,/setControlState\(['"]jump['"],/);
});

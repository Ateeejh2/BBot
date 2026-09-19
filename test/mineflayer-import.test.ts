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
  assert.match(source,/const canSprint =/);
  assert.match(source,/setControlState\(['"]sprint['"],\s*canSprint\)/);
  assert.doesNotMatch(source,/await\s+bot\.look\s*\(/);
  assert.match(source,/setControlState\(['"]forward['"],\s*true\)/);
  assert.match(source,/setControlState\(['"]jump['"],/);
});


test('movement planner prefers full-block footing but keeps slab routes available', async () => {
  const source = await readFile('src/bot/mineflayer.ts','utf8');
  assert.match(source,/exclusionAreasStep\.push/);
  assert.match(source,/isPartialSlab/);
  assert.match(source,/\? 12 : 0/);
  assert.doesNotMatch(source,/blocksToAvoid\.add\([^\n]*slab/i);
});


test('movement planner continues partial A-star slices instead of treating them as timeout', async () => {
  const source = await readFile('src/bot/mineflayer.ts','utf8');
  assert.match(source,/getPathFromTo\(/);
  assert.match(source,/plan\.status !== 'partial'/);
  assert.match(source,/setImmediate\(/);
  assert.doesNotMatch(source,/const plan = bot\.pathfinder\.getPathTo\(/);
});


test('movement executor does not skip one-block jumps and replans after horizontal collision', async () => {
  const source = await readFile('src/bot/mineflayer.ts','utf8');
  assert.match(source,/Math\.abs\(dy\) < 0\.35/);
  assert.match(source,/const needsJump = dy > 0\.35/);
  assert.match(source,/isCollidedHorizontally/);
  assert.match(source,/collided && !needsJump && aligned/);
  assert.match(source,/control walk collision/);
});


test('sprint stays held across flat waypoints and movement cadence is traced', async () => {
  const source = await readFile('src/bot/mineflayer.ts','utf8');
  assert.match(source,/const canSprint = aligned && !collided && !needsJump;/);
  assert.doesNotMatch(source,/canSprint = [^;]*horizontal >/);
  assert.match(source,/movementPacketTimes/);
  assert.match(source,/sprintActionTimes/);
  assert.match(source,/movementPacketBursts/);
});

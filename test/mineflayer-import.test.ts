import test from 'node:test';
import assert from 'node:assert/strict';
import { createMineflayerTransport } from '../src/bot/mineflayer.js';

test('mineflayer transport module loads under Node ESM', () => {
  assert.equal(typeof createMineflayerTransport, 'function');
});

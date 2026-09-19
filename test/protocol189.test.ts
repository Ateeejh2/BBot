import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadConfig } from '../src/config/index.js';
const require = createRequire(import.meta.url);
test('offline dependency smoke: pinned 1.8.9 resolves protocol 47 and plugin exports', () => {
  const version = loadConfig({}).version;
  assert.equal(version, '1.8.9');
  // This verifies dependency data loading only. It does not open a socket or test server behavior.
  const minecraftData = require('minecraft-data') as (version: string) => { version: { version: number; minecraftVersion: string }; protocol: unknown };
  const data = minecraftData(version);
  assert.equal(data.version.version, 47);
  assert.ok(data.protocol);
  const protocol = require('minecraft-protocol') as { createSerializer(options: object): unknown; createDeserializer(options: object): unknown };
  assert.ok(protocol.createSerializer({ version, state: 'play' }));
  assert.ok(protocol.createDeserializer({ version, state: 'play' }));
  const mineflayer = require('mineflayer') as { createBot: unknown };
  const pathfinder = require('mineflayer-pathfinder') as { pathfinder: unknown; Movements: unknown; goals: { GoalNear: unknown } };
  assert.equal(typeof mineflayer.createBot, 'function');
  assert.equal(typeof pathfinder.pathfinder, 'function');
  assert.equal(typeof pathfinder.Movements, 'function');
  assert.equal(typeof pathfinder.goals.GoalNear, 'function');
});
import { eligibleServerAnnouncementChannel, eligibleTransferChannel } from '../src/bot/message-source.js';
test('legacy chat is opt-in; sender metadata is accepted only for an exact transfer match', () => {
  assert.equal(eligibleTransferChannel('system', null, 'system'), true);
  assert.equal(eligibleTransferChannel('chat', null, 'system'), false);
  assert.equal(eligibleTransferChannel('chat', null, 'chat'), true);
  assert.equal(eligibleTransferChannel('chat', 'player-uuid', 'chat'), false);
  assert.equal(eligibleTransferChannel('chat', 'player-uuid', 'chat', true), true);
  assert.equal(eligibleTransferChannel('system', 'sender', 'system', true), false);
  assert.equal(eligibleTransferChannel('game_info', null, 'chat', true), false);
  assert.equal(eligibleTransferChannel('title', null, 'system', true), false);
});

test('exact server event announcements accept sender-less legacy chat or system only', () => {
  assert.equal(eligibleServerAnnouncementChannel('chat', null, true), true);
  assert.equal(eligibleServerAnnouncementChannel('system', undefined, true), true);
  assert.equal(eligibleServerAnnouncementChannel('chat', 'player-uuid', true), false);
  assert.equal(eligibleServerAnnouncementChannel('system', 'sender', true), false);
  assert.equal(eligibleServerAnnouncementChannel('game_info', null, true), false);
  assert.equal(eligibleServerAnnouncementChannel('chat', null, false), false);
});

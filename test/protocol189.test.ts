import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
import { eligibleServerAnnouncementChannel, eligibleTransferChannel, isDeathNotice, isLimboNotice } from '../src/bot/message-source.js';
test('legacy chat is opt-in; exact sender-less transfer notices accept chat or system', () => {
  assert.equal(eligibleTransferChannel('system', null, 'system'), true);
  assert.equal(eligibleTransferChannel('chat', null, 'system'), false);
  assert.equal(eligibleTransferChannel('chat', null, 'chat'), true);
  assert.equal(eligibleTransferChannel('chat', null, 'system', true), true);
  assert.equal(eligibleTransferChannel('system', null, 'chat', true), true);
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

test('Limbo notice requires an exact normalized server line', () => {
  assert.equal(isLimboNotice('You were spawned in Limbo.'), true);
  assert.equal(isLimboNotice('§eYou were spawned in Limbo.'), true);
  assert.equal(isLimboNotice('SomePlayer: You were spawned in Limbo.'), false);
  assert.equal(isLimboNotice('[MVP+] SomePlayer: You were spawned in Limbo.'), false);
  assert.equal(eligibleServerAnnouncementChannel('chat', 'player-uuid', isLimboNotice('You were spawned in Limbo.')), false);
});

test('Pit death recap requires the whole normalized server line', () => {
  assert.equal(isDeathNotice('DEATH! by [9] SuperRuzgar2341 VIEW RECAP'), true);
  assert.equal(isDeathNotice('§cDEATH! §7by §f[120] Any_Player §eVIEW RECAP'), true);
  assert.equal(isDeathNotice('[MVP+] Player: DEATH! by [9] SuperRuzgar2341 VIEW RECAP'), false);
  assert.equal(isDeathNotice('DEATH! by someone'), false);
  assert.equal(eligibleServerAnnouncementChannel('chat', 'player-uuid',
    isDeathNotice('DEATH! by [9] SuperRuzgar2341 VIEW RECAP')), false);
});


test('Care Package click press and release are split across client ticks', () => {
  const source=readFileSync(
    new URL('../../poc/headless-forge-1.8.9/src/main/java/com/bbot/poc/BBotHeadlessPoc.java',import.meta.url),
    'utf8'
  );
  assert.match(source,/if \(carePackageClickPressed\) \{[\s\S]*?releaseCarePackageClick\(\);[\s\S]*?return;/);
  assert.match(source,/mc\.thePlayer\.swingItem\(\);[\s\S]*?mc\.playerController\.clickBlock\(carePackageTarget, EnumFacing\.UP\)/);
  assert.doesNotMatch(source,/clickBlock\(carePackageTarget, EnumFacing\.UP\);\s*mc\.playerController\.resetBlockRemoving\(\);/);
});

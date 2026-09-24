# BBot Care Package local test server

Local Spigot 1.8.8 server for repeatable BBot Care Package testing.

## Quick start

```bash
cd /workspaces/BBot
npm run test-server:setup
npm run test-server:use
npm run test-server:start
```

Keep the server terminal open. In another terminal, build/start BBot normally:

```bash
cd /workspaces/BBot
npm run validate:forge-local
npm start
```

From the Dashboard use **Launch → Start** on bot-1. The plugin emulates `/play pit` and transfers the bot to the local `caretest` instance. Wait until BBot reports **Idle**.

Then run this in the test-server console:

```text
caretest start
```

The server sends the same Care Package announcement format BBot watches, waits one second, places a chest at `8 65 0`, and exposes the 200-click / OPEN / loot flow.

## Care Package commands

```text
caretest start [clicks]
caretest status
caretest knockback [strength]
caretest autokb <remaining|off> [strength]
caretest lootdelay <ticks>
caretest vanish
caretest stop
```

Examples:

```text
caretest start 200
caretest autokb 120 1.5
caretest lootdelay 10
caretest status
```

`status` reports **acceptedClicks** from the server plugin. That value is useful beside Dashboard `Clicks Sent`, but it is a local test-server measurement, not a Hypixel/Watchdog signal.

## Vulcan

Vulcan is not bundled or downloaded. If you have a licensed, compatible Vulcan jar, place it in:

```text
test-server/runtime/plugins/
```

before `npm run test-server:start`. The server will load it like any other Bukkit/Spigot plugin. Use its normal logs/alerts only as an independent compatibility signal; this harness does not attempt to suppress or bypass anti-cheat checks.

## Restore normal BBot server settings

```bash
cd /workspaces/BBot
npm run test-server:restore
```

This restores the `.env` saved by the first `test-server:use` invocation.

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
caretest packets [player] [limit]
caretest packets clear
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

### Packet telemetry

The CareTest plugin also taps the Spigot 1.8.8 Netty pipeline directly. During an active Care Package it records inbound:

- `ARM_ANIMATION`
- `BLOCK_DIG` including dig action, block position and face
- `BLOCK_PLACE`
- `FLYING` / position-look packet classes
- `WINDOW_CLICK`
- `CLOSE_WINDOW`

`caretest status` shows the per-player packet counters beside server-accepted Care Package clicks. `caretest packets` dumps the most recent 40 packet records for the only/current player; an explicit player and limit can also be supplied.

```text
caretest status
caretest packets
caretest packets Ruth0102 80
caretest packets clear
```

Example trace shape:

```text
#41 +2137ms ARM_ANIMATION
#42 +2138ms BLOCK_DIG START_DESTROY_BLOCK @ 8,65,0 face=UP
#43 +2186ms FLYING PacketPlayInPositionLook
```

This telemetry is for comparing the packets the server actually receives with BBot's `Clicks Sent` and the harness's `acceptedClicks`. It does not interpret or reproduce Vulcan's detection rules.

## Vulcan

Vulcan itself is not committed to this repository. For the verified local copy of **Vulcan 2.9.7.22**, upload the jar into your Codespace, then install it with:

```bash
npm run test-server:install-vulcan -- /path/to/Vulcan.jar
```

The installer verifies the expected Vulcan SHA-256, checks `plugin.yml`, then downloads and SHA-verifies the required **PacketEvents 2.14.0** Spigot plugin from its official GitHub release.

This Vulcan 2.9.7.22 jar contains Java 21 bytecode. With Vulcan installed, `test-server:start` therefore uses `TEST_SERVER_JAVA_HOME` or the system Java and requires Java 21+. This does **not** change the Forge 1.8.9 requirement: Forge continues to use `JAVA8_HOME`.

Example:

```bash
export TEST_SERVER_JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
npm run test-server:start
```

Use Vulcan's normal alerts/logs only as an independent compatibility signal; this harness does not attempt to suppress or bypass anti-cheat checks.

## Restore normal BBot server settings

```bash
cd /workspaces/BBot
npm run test-server:restore
```

This restores the `.env` saved by the first `test-server:use` invocation.

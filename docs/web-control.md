# BBot Web control

The Remote Web setup now provisions a 20-slot fleet. Run `npm run setup:web-control` to set `MODE=live`, `BOT_COUNT=20`, `TRANSFER_MESSAGE_CHANNEL=chat`, `API_ENABLED=true`, `API_HOST=127.0.0.1`, and the Codespaces Web origin in the local `.env`. Existing server, viewer, and credential settings are preserved.

A bot slot stays stopped until it has an account assignment and Start is requested. Each assigned bot follows the existing run loop:

```
DISCONNECTED
-> CONNECTING
-> LOBBY
-> /play pit after PLAY_COOLDOWN_MS
-> JOINING_PIT
-> confirmed transfer + spawn
-> IN_PIT_IDLE
```

Explicit starts share the global `CONNECTION_SPACING_MS` limiter. If several bots are started together, the first can enter `CONNECTING` immediately and later bots remain visibly queued until their turn. A queued Start can be cancelled with Stop. The Web **Start Assigned** action schedules every disconnected bot that has a READY assigned account; **Stop All** stops connected bots and cancels queued starts.

Remote Settings edits only the Minecraft host and port; Java 1.8.9 remains fixed. Server settings can only be changed while every bot is fully stopped, including no queued Starts. Runtime server settings are stored in `data/server-connection.json`.

## Accounts

Public account metadata and bot assignments are stored in `data/accounts-runtime.json`. Authentication material is never returned in REST snapshots or WebSocket snapshots and is not written to browser storage or structured logs.

Microsoft accounts use prismarine-auth device flow and the backend profile cache. The Web can open the Microsoft sign-in page using the device code. Access and refresh tokens remain backend-only.

Session accounts accept a Minecraft Services Access Token. The backend calls the Minecraft profile endpoint to resolve the MCID and profile UUID, then stores the credential in `.auth/session/<account-id>.json` with restrictive permissions where supported. The public account record contains only metadata. A Session token can be replaced from the Web without recreating the account. Replacement is allowed only while the assigned bot is fully stopped and only when the new token resolves to the same profile UUID.

Before a Session bot starts, the backend verifies the stored token. If it is invalid or expired, the account becomes `ERROR` with `SESSION_TOKEN_INVALID`, the bot stays stopped, and the Web shows **Replace Token required**. If a connection fails before spawn, BBot rechecks the Session token; only a confirmed invalid token pauses automatic reconnect.

Account assignment changes and deletion require the affected bot to be fully stopped. Microsoft deletion keeps its auth cache to avoid destructive credential loss; Session deletion removes its backend credential file.

## Fleet behavior

The API supports up to 20 configured bot slots. In API mode, an older `accounts.json` with fewer entries than `BOT_COUNT` is accepted; the remaining slots are padded as unassigned placeholders. Runtime account assignment remains authoritative once `data/accounts-runtime.json` exists.

Useful fleet actions:

```
POST /api/v1/fleet/actions/start-assigned
POST /api/v1/fleet/actions/stop-all
```

The first schedules READY assigned bots and reports started/skipped bot IDs. The second stops active bots and cancels queued starts. Per-bot Start/Stop endpoints remain available.

## Development / Codespaces

BBot-Web's Vite server proxies `/api/v1` and WebSocket traffic to `127.0.0.1:3008`. Keep BBot and BBot-Web in the same Codespace for this development setup. Keep the forwarded Web port private; never expose port 3008 directly.

```sh
# BBot terminal
cd /workspaces/BBot
git pull
npm ci
npm run setup:web-control
npm run build
npm start

# BBot-Web terminal
cd /workspaces/BBot-Web
git pull
npm ci
VITE_BBOT_MODE=remote npm run dev -- --host 0.0.0.0

# Optional Live View tunnel
cd /workspaces/BBot
npm run setup:viewer
npm run viewer:tunnel
```

After restart, the Bots page should show 20 slots. Add Microsoft or Session accounts, assign each READY account to a different bot, then either Start individually or use **Start Assigned**. Connection attempts are staggered instead of opening all clients simultaneously. Each bot independently reports MCID, state, instance, position, and last kick reason.

Live View still targets the configured `VIEWER_BOT_ID`. Quick Tunnel URLs are public while the tunnel process is running, so stop the tunnel after testing. The management API remains bound to `127.0.0.1`, validates the browser Origin, and does not expose a generic Minecraft command endpoint.

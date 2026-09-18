# One-bot Web control

Set `MODE=live`, `BOT_COUNT=1`, `TRANSFER_MESSAGE_CHANNEL=chat`, `API_ENABLED=true`, `API_ORIGIN` to the exact BBot-Web browser origin, and keep `API_HOST=127.0.0.1` in the local `.env`. `API_PORT` defaults to 3008. With the API enabled, the bot starts disconnected until Start is pressed. Start begins the full run loop: connect, wait for the first spawn and `LOBBY`, respect `PLAY_COOLDOWN_MS`, then automatically send only `/play pit`. The transfer notification and a later spawn confirm `IN_PIT_IDLE`. Stop disables the loop and prevents reconnects until Start is pressed again. The dedicated Join Pit endpoint remains only for diagnostics/backward compatibility and is not required by the normal UI.

Settings in Remote mode edits only the Minecraft host and port (`1.8.9` is fixed). The backend validates them and stores `data/server-connection.json`; on restart this overrides `SERVER_HOST` and `SERVER_PORT` from `.env`. A change while any bot is active returns 409. Web does not edit `.env`. Accounts in Remote mode stores public account metadata and bot assignments in `data/accounts-runtime.json`; this file and `.auth/` are excluded from Git. A previously configured Microsoft account in `accounts.json` is imported in memory when no runtime account file exists, preserving its existing `.auth/<label>` cache. New installations can omit `accounts.json` entirely. After a Microsoft account reaches `READY`, assign it to `bot-1` while disconnected, then press Start. Changing an assignment while the bot is active returns 409.

The installed Mineflayer 4.39.0 uses minecraft-protocol 1.68.0 and prismarine-auth 3.1.1. The backend uses the same Microsoft device flow and profile cache for account enrollment. First authorization still requires the local BBot terminal's device prompt. Device codes never appear in REST responses, WebSocket messages, browser storage, or the structured/file logger. The old minecraft-protocol `session` option belongs to legacy Mojang authentication, not a verified Microsoft session import path. Session Account input is therefore unavailable; the API explicitly rejects it instead of accepting credentials it cannot safely use.

BBot-Web's Vite development server proxies `/api/v1` (including WebSocket) to `127.0.0.1:3008`. Set `VITE_BBOT_MODE=remote` when starting the Web server; omit it for the original Mock UI. Browser calls use the Web origin and do not store authentication material. Keep the forwarded Web port private. For a public deployment, put both the Web app and its `/api/v1` proxy behind Cloudflare Access or equivalent identity enforcement; the Origin check alone is not authentication. Never expose port 3008 directly through a tunnel. A production reverse proxy must forward WebSocket upgrades and the original Origin header.

For Live View, enable the existing Viewer. In Codespaces testing, leave `VIEWER_PUBLIC_URL` blank and run `npm run viewer:tunnel` in another BBot terminal. The helper waits until the Viewer is reachable, starts a Cloudflare Quick Tunnel, detects the temporary `https://...trycloudflare.com` URL, and publishes it through the backend status automatically for `VIEWER_BOT_ID`; no browser URL copy/paste is needed. A static `VIEWER_PUBLIC_URL` remains available for a protected production tunnel. Viewer URLs may contain no credentials, query, fragment, or token path. Quick Tunnel URLs are public while the helper is running, so stop that terminal after testing. The API sends only allowlisted bot state, position, instance, limited safe logs, and the configured viewer URL. It does not accept raw Minecraft commands. Party, Warp, and Trade remain mock-only pending dedicated validated backend actions.

In Codespaces, from each repository after initial `npm ci`:

```sh
# BBot terminal (one-time Codespaces setup writes only non-secret local .env settings)
npm run setup:web-control && npm run build && npm start
# BBot-Web terminal
VITE_BBOT_MODE=remote npm run dev -- --host 0.0.0.0
# Optional Live View tunnel terminal (BBot repo; can be started before Connect)
npm run viewer:tunnel
```

Open the private forwarded Web port. In Settings, save the server host and port; in Accounts, add Microsoft and complete the local terminal prompt, wait for READY and assign to bot-1. Press Start once and verify the automatic `CONNECTING -> LOBBY -> JOINING_PIT -> IN_PIT_IDLE` flow, instance, coordinates, logs, and Live View. Press Stop and verify `DISCONNECTED`. Never paste a code or token into the browser or chat.

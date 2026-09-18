# One-bot Web control

Set `MODE=live`, `BOT_COUNT=1`, `TRANSFER_MESSAGE_CHANNEL=chat`, `API_ENABLED=true`, `API_ORIGIN` to the exact BBot-Web browser origin, and keep `API_HOST=127.0.0.1` in the local `.env`. `API_PORT` defaults to 3008. With the API enabled, the bot starts disconnected until Start is pressed. Start begins the full run loop: connect, wait for the first spawn and `LOBBY`, respect `PLAY_COOLDOWN_MS`, then automatically send only `/play pit`. The transfer notification and a later spawn confirm `IN_PIT_IDLE`. Stop disables the loop and prevents reconnects until Start is pressed again. The dedicated Join Pit endpoint remains only for diagnostics/backward compatibility and is not required by the normal UI.

BBot-Web's Vite development server proxies `/api/v1` (including WebSocket) to `127.0.0.1:3008`. Set `VITE_BBOT_MODE=remote` when starting the Web server; omit it for the original Mock UI. Browser calls use the Web origin and do not store authentication material. Keep the forwarded Web port private. For a public deployment, put both the Web app and its `/api/v1` proxy behind Cloudflare Access or equivalent identity enforcement; the Origin check alone is not authentication. Never expose port 3008 directly through a tunnel. A production reverse proxy must forward WebSocket upgrades and the original Origin header.

For Live View, enable the existing Viewer. In Codespaces testing, leave `VIEWER_PUBLIC_URL` blank and run `npm run viewer:tunnel` in another BBot terminal. The helper waits until the Viewer is reachable, starts a Cloudflare Quick Tunnel, detects the temporary `https://...trycloudflare.com` URL, and publishes it through the backend status automatically for `VIEWER_BOT_ID`; no browser URL copy/paste is needed. A static `VIEWER_PUBLIC_URL` remains available for a protected production tunnel. Viewer URLs may contain no credentials, query, fragment, or token path. Quick Tunnel URLs are public while the helper is running, so stop that terminal after testing. The API sends only allowlisted bot state, position, instance, limited safe logs, and the configured viewer URL. It does not accept raw Minecraft commands. Party, Warp, and Trade remain mock-only pending dedicated validated backend actions.

In Codespaces, from each repository after initial `npm ci`:

```sh
# BBot terminal (after setting .env locally and keeping it out of git)
npm run build && npm start
# BBot-Web terminal
VITE_BBOT_MODE=remote npm run dev -- --host 0.0.0.0
# Optional Live View tunnel terminal (BBot repo; can be started before Connect)
npm run viewer:tunnel
```

Open the private forwarded Web port, press Start once, and verify the automatic `CONNECTING -> LOBBY -> JOINING_PIT -> IN_PIT_IDLE` flow, instance, coordinates, logs, and Live View. Press Stop and verify `DISCONNECTED`. A Microsoft sign-in prompt remains in the BBot terminal only; never paste its code or token into the browser or chat.

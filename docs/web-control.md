# One-bot Web control

Set `MODE=live`, `BOT_COUNT=1`, `TRANSFER_MESSAGE_CHANNEL=chat`, `API_ENABLED=true`, `API_ORIGIN` to the exact BBot-Web browser origin, and keep `API_HOST=127.0.0.1` in the local `.env`. `API_PORT` defaults to 3008. With the API enabled, the bot starts disconnected until Connect is pressed. On the first spawn it enters LOBBY; Join Pit sends only `/play pit`. The transfer notification and a later spawn confirm `IN_PIT_IDLE`. Disconnect stops reconnects for that bot until Connect is pressed again.

BBot-Web's Vite development server proxies `/api/v1` (including WebSocket) to `127.0.0.1:3008`. Set `VITE_BBOT_MODE=remote` when starting the Web server; omit it for the original Mock UI. Browser calls use the Web origin and do not store authentication material. Keep the forwarded Web port private. For a public deployment, put both the Web app and its `/api/v1` proxy behind Cloudflare Access or equivalent identity enforcement; the Origin check alone is not authentication. Never expose port 3008 directly through a tunnel. A production reverse proxy must forward WebSocket upgrades and the original Origin header.

For Live View, enable the existing Viewer and set `VIEWER_PUBLIC_URL` to its HTTPS base URL in the backend `.env`; status supplies that URL for `VIEWER_BOT_ID`, so the selected real bot opens it without manual entry. Viewer URLs may contain no credentials, query, fragment, or token path. Restrict the Viewer tunnel separately before sharing the Web interface. The API sends only allowlisted bot state, position, instance, limited safe logs, and the configured viewer URL. It does not accept raw Minecraft commands. Party, Warp, and Trade remain mock-only pending dedicated validated backend actions.

In Codespaces, from each repository after initial `npm ci`:

```sh
# BBot terminal (after setting .env locally and keeping it out of git)
npm run build && npm start
# BBot-Web terminal
VITE_BBOT_MODE=remote npm run dev -- --host 0.0.0.0
```

Open the private forwarded Web port, then Connect, Join Pit after LOBBY, and verify `IN_PIT_IDLE`, instance, coordinates, logs, and Live View. Disconnect and verify `DISCONNECTED`. A Microsoft sign-in prompt remains in the BBot terminal only; never paste its code or token into the browser or chat.

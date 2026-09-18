import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { BotManager } from '../bot/manager.js';
import type { Config } from '../config/index.js';
import { safeKickReason, type Logger } from '../logging/logger.js';
import type { ControlStore } from '../runtime/control.js';

function runtimeViewerUrl(config: Config): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(config.dataDir, 'viewer-public-url.json'), 'utf8')) as { url?: unknown };
    if (typeof raw.url !== 'string') return undefined;
    const url = new URL(raw.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || url.pathname !== '/') return undefined;
    if (!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

// Only fixed, operator-facing fields cross the API boundary. Never serialize transports or config.
export function createManagementApi(manager: BotManager, config: Config, logger: Logger, controls?: ControlStore) {
  const origin = config.api.origin!;
  const logs: Array<{ id: number; at: number; level: string; message: string; botId?: string; instanceId?: string; kickReason?: string }> = [];
  let sequence = 0;
  const unsubscribe = logger.subscribe((level, message, fields) => {
    if (!fields.botId || !/^(state changed|bot kicked|instance confirmed after transfer spawn|join timed out; no confirmed instance|membership lost; recovering|join attempt budget exhausted; inspect and restart after diagnosis|transport error \(details withheld\))$/.test(message)) return;
    logs.push({ id: ++sequence, at: Date.now(), level: level.toUpperCase(), message,
      botId: fields.botId, instanceId: typeof fields.instance === 'string' ? fields.instance : undefined,
      kickReason: message === 'bot kicked' ? safeKickReason(fields.kickReason) : undefined });
    if (logs.length > 100) logs.shift();
    broadcast();
  });
  const snapshot = () => {
    const viewerUrl = runtimeViewerUrl(config) ?? config.viewer.publicUrl;
    return { version: 1, bots: manager.views(),
      instances: manager.registry.snapshot().map(r => ({ id: r.id, status: r.status, firstSeen: r.firstSeen, lastSeen: r.lastSeen })),
      logs: [...logs], serverConnection: controls?.getServer(), accounts: controls?.listAccounts(), viewer: config.viewer.enabled && viewerUrl
        ? { botId: config.viewer.botId, url: viewerUrl } : null };
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  let previous = '';
  function broadcast() {
    const body = JSON.stringify({ type: 'snapshot', data: snapshot() });
    if (body === previous) return;
    previous = body;
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 100_000) client.terminate(); else client.send(body);
    }
  }
  const timer = setInterval(broadcast, 500);
  const send = (res: ServerResponse, status: number, data: object) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'access-control-allow-origin': origin, 'vary': 'Origin', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(data));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin !== origin && !(req.method === 'GET' && req.headers.origin === undefined && req.headers['x-bbot-ui'] === '1')) { res.writeHead(403); res.end(); return; }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-BBot-UI', 'vary': 'Origin' }); res.end(); return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/status') { send(res, 200, snapshot()); return; }
    if (controls && req.method === 'GET' && req.url === '/api/v1/settings/server') { send(res, 200, controls.getServer()); return; }
    if (controls && req.method === 'GET' && req.url === '/api/v1/accounts') { send(res, 200, { accounts: controls.listAccounts() }); return; }
    const match = /^\/api\/v1\/bots\/(bot-[1-9]\d*)\/actions\/(connect|join-pit|disconnect)$/.exec(req.url ?? '');
    const assignment = /^\/api\/v1\/bots\/(bot-[1-9]\d*)\/account$/.exec(req.url ?? '');
    const retry = /^\/api\/v1\/accounts\/([0-9a-f-]{36})\/actions\/retry-auth$/.exec(req.url ?? '');
    const accountDelete = /^\/api\/v1\/accounts\/([0-9a-f-]{36})$/.exec(req.url ?? '');
    const settingsWrite = !!controls && req.method === 'PUT' && req.url === '/api/v1/settings/server';
    const accountWrite = !!controls && req.method === 'POST' && req.url === '/api/v1/accounts';
    const assignmentWrite = !!controls && req.method === 'PUT' && !!assignment;
    const retryWrite = !!controls && req.method === 'POST' && !!retry;
    const deleteWrite = !!controls && req.method === 'DELETE' && !!accountDelete;
    if (deleteWrite) {
      void controls!.deleteAccount(accountDelete![1]!).then(result => { broadcast(); send(res, 200, result); }).catch(error => {
        const code = error instanceof Error ? error.message : '';
        const status = ['UNKNOWN_BOT', 'UNKNOWN_ACCOUNT'].includes(code) ? 404 :
          ['INVALID_STATE', 'CONFLICT'].includes(code) ? 409 : 500;
        send(res, status, { error: status === 500 ? 'INTERNAL_ERROR' : code });
      });
      return;
    }
    if (!(req.method === 'POST' && match) && !settingsWrite && !accountWrite && !assignmentWrite && !retryWrite) { send(res, 404, { error: 'NOT_FOUND' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { send(res, 415, { error: 'CONTENT_TYPE' }); return; }
    let size = 0, body = '';
    req.on('data', chunk => { size += chunk.length; if (size <= 1024) body += chunk.toString(); });
    req.on('end', () => { void (async () => {
      if (size > 1024) { send(res, 413, { error: 'INVALID_BODY' }); return; }
      try {
        let data: unknown;
        try { data = JSON.parse(body); } catch { throw Error('INVALID_INPUT'); }
        if (settingsWrite) { const result = await controls!.saveServer(data); broadcast(); send(res, 200, result); return; }
        if (accountWrite) { const result = await controls!.addAccount(data); broadcast(); send(res, 201, result); return; }
        if (assignmentWrite) { const result = await controls!.assign(assignment![1]!, data); broadcast(); send(res, 200, result); return; }
        if (retryWrite) { if (JSON.stringify(data) !== '{}') throw Error('INVALID_INPUT'); const result = await controls!.retryAccount(retry![1]!); broadcast(); send(res, 200, result); return; }
        if (JSON.stringify(data) !== '{}') throw Error('INVALID_INPUT');
        if (controls?.busy) throw Error('CONFLICT');
        const [, id, action] = match!;
        if (action === 'connect') manager.connectBot(id!);
        else if (action === 'join-pit') manager.joinPit(id!);
        else manager.disconnectBot(id!);
        broadcast(); send(res, 200, snapshot());
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const status = code === 'INVALID_INPUT' ? 400 : code === 'UNSUPPORTED_AUTH' ? 422 :
          ['UNKNOWN_BOT', 'UNKNOWN_ACCOUNT'].includes(code) ? 404 :
          ['INVALID_STATE', 'ACCOUNT_REQUIRED', 'CONFLICT'].includes(code) ? 409 : 500;
        send(res, status, { error: status === 500 ? 'INTERNAL_ERROR' : code });
      }
    })(); });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/v1/events' || req.headers.origin !== origin) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => { wss.emit('connection', ws, req); });
  });
  wss.on('connection', ws => { ws.send(JSON.stringify({ type: 'snapshot', data: snapshot() })); });
  return {
    listen: () => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.api.port, config.api.host, resolve); }),
    close: () => new Promise<void>(resolve => { clearInterval(timer); unsubscribe(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(() => resolve()); }),
    address: () => server.address()
  };
}

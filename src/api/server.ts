import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { BotManager } from '../bot/manager.js';
import { validEvent, type GameEvent, type Job } from '../core/types.js';
import type { Config } from '../config/index.js';
import { safeKickReason, type Logger } from '../logging/logger.js';
import type { ControlStore } from '../runtime/control.js';
import { RuntimePerformanceMonitor } from '../runtime/performance.js';
import type { CarePackageSchedule } from '../events/brooke.js';

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

function publicJob(job: Job, maxAttempts: number) {
  return { id: job.id, eventType: job.event.type, instanceId: job.event.instanceId, state: job.state, botId: job.botId,
    x: job.event.target.x, y: job.event.target.y, z: job.event.target.z, expiresAt: job.event.expiresAt,
    attempts: job.attempts, maxAttempts, lastFailure: job.lastFailure, lastFailureAt: job.lastFailureAt, retryAt: job.retryAt };
}

function manualJob(value: unknown, now: number): GameEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_INPUT');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'eventType,expiresAt,instanceId,target') throw Error('INVALID_INPUT');
  if (!body.target || typeof body.target !== 'object' || Array.isArray(body.target)) throw Error('INVALID_INPUT');
  const target = body.target as Record<string, unknown>;
  if (Object.keys(target).sort().join(',') !== 'x,y,z') throw Error('INVALID_INPUT');
  const event: GameEvent = {
    id: `manual-${randomUUID()}`,
    instanceId: typeof body.instanceId === 'string' ? body.instanceId : '',
    type: typeof body.eventType === 'string' ? body.eventType : '',
    target: { x: typeof target.x === 'number' ? target.x : NaN, y: typeof target.y === 'number' ? target.y : NaN, z: typeof target.z === 'number' ? target.z : NaN },
    expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : NaN,
    metadata: { source: 'manual' }
  };
  if (!validEvent(event) || event.expiresAt <= now || !/^[A-Za-z0-9_.:-]{1,64}$/.test(event.type)) throw Error('INVALID_INPUT');
  return event;
}

// Only fixed, operator-facing fields cross the API boundary. Never serialize transports or config.
export function createManagementApi(manager: BotManager, config: Config, logger: Logger, controls?: ControlStore, carePackages?: CarePackageSchedule) {
  const origin = config.api.origin!;
  const performance = new RuntimePerformanceMonitor();
  const logs: Array<{ id: number; at: number; level: string; message: string; botId?: string; instanceId?: string; kickReason?: string; detail?: string }> = [];
  let sequence = 0;
  const unsubscribe = logger.subscribe((level, message, fields) => {
    if (!fields.botId || !/^(state changed|bot kicked|instance confirmed after transfer signals|join timed out; no confirmed instance|membership lost; recovering|join attempt budget exhausted; inspect and restart after diagnosis|transport error \(details withheld\)|job returned or failed|care package event started|care package launch started|care package launch completed|care package launch failed|care package waiting for chest|care package chest detected|care package chest path started|care package chest handoff failed|care package preparation expired|care package test started|care package test chest generated|care package test chest path started|care package test failed|launch pad test started|launch pad test completed|launch pad test failed|viewer start requested|viewer started|viewer start failed|movement debug waiting for position settle|movement debug path started|movement debug path completed|movement debug path failed|control path planning failed|control walk collision|launch pad selected|server position correction|movement packet after correction|velocity packet after correction|physics tick after correction)$/.test(message)) return;
    logs.push({ id: ++sequence, at: Date.now(), level: level.toUpperCase(), message,
      botId: fields.botId, instanceId: typeof fields.instance === 'string' ? fields.instance : undefined,
      kickReason: message === 'bot kicked' ? safeKickReason(fields.kickReason) : undefined,
      detail: ['launch pad test failed','care package test failed','movement debug path failed'].includes(message) && typeof fields.reason === 'string' ? fields.reason :
        message === 'control path planning failed'
          ? `status=${typeof fields.status === 'string' ? fields.status : '?'} visited=${typeof fields.visitedNodes === 'number' ? fields.visitedNodes : '?'} generated=${typeof fields.generatedNodes === 'number' ? fields.generatedNodes : '?'} time=${typeof fields.planningMs === 'number' ? fields.planningMs.toFixed(1) : '?'}ms target=${typeof fields.targetX === 'number' ? fields.targetX.toFixed(1) : '?'},${typeof fields.targetY === 'number' ? fields.targetY.toFixed(1) : '?'},${typeof fields.targetZ === 'number' ? fields.targetZ.toFixed(1) : '?'}`
        : message === 'control walk collision'
          ? `replan=${typeof fields.replan === 'number' ? fields.replan : '?'} pos=${typeof fields.x === 'number' ? fields.x.toFixed(2) : '?'},${typeof fields.y === 'number' ? fields.y.toFixed(2) : '?'},${typeof fields.z === 'number' ? fields.z.toFixed(2) : '?'} waypoint=${typeof fields.waypointX === 'number' ? fields.waypointX.toFixed(2) : '?'},${typeof fields.waypointY === 'number' ? fields.waypointY.toFixed(2) : '?'},${typeof fields.waypointZ === 'number' ? fields.waypointZ.toFixed(2) : '?'}`
        : message === 'launch pad selected'
          ? `candidates=${typeof fields.candidates === 'number' ? fields.candidates : '?'} blocks=${typeof fields.blocks === 'number' ? fields.blocks : '?'} pad=${typeof fields.padX === 'number' ? fields.padX.toFixed(1) : '?'},${typeof fields.padY === 'number' ? fields.padY.toFixed(1) : '?'},${typeof fields.padZ === 'number' ? fields.padZ.toFixed(1) : '?'}` :
        message === 'server position correction'
          ? `Δh=${typeof fields.horizontal === 'number' ? fields.horizontal.toFixed(3) : '?'} Δy=${typeof fields.vertical === 'number' ? fields.vertical.toFixed(3) : '?'} ` +
            `pos=${typeof fields.beforeX === 'number' ? fields.beforeX.toFixed(2) : '?'},${typeof fields.beforeY === 'number' ? fields.beforeY.toFixed(2) : '?'},${typeof fields.beforeZ === 'number' ? fields.beforeZ.toFixed(2) : '?'}→${typeof fields.targetX === 'number' ? fields.targetX.toFixed(2) : '?'},${typeof fields.targetY === 'number' ? fields.targetY.toFixed(2) : '?'},${typeof fields.targetZ === 'number' ? fields.targetZ.toFixed(2) : '?'} ` +
            `vel=${typeof fields.velocityX === 'number' ? fields.velocityX.toFixed(3) : '?'},${typeof fields.velocityY === 'number' ? fields.velocityY.toFixed(3) : '?'},${typeof fields.velocityZ === 'number' ? fields.velocityZ.toFixed(3) : '?'} ` +
            `walk=${typeof fields.walkingSpeed === 'number' ? fields.walkingSpeed.toFixed(4) : '?'} attr=${typeof fields.movementAttributeValue === 'number' ? fields.movementAttributeValue.toFixed(4) : '?'} effective=${typeof fields.effectiveMovementSpeed === 'number' ? fields.effectiveMovementSpeed.toFixed(4) : '?'} mods=${typeof fields.movementModifierCount === 'number' ? fields.movementModifierCount : '?'}[${typeof fields.movementModifiers === 'string' ? fields.movementModifiers : '?'}] effects=${typeof fields.effects === 'string' ? fields.effects : '?'} ` +
            `rel=${Boolean(fields.relativeX)?'X':'-'}${Boolean(fields.relativeY)?'Y':'-'}${Boolean(fields.relativeZ)?'Z':'-'} floor=${typeof fields.floorBlock === 'string' ? fields.floorBlock : '?'}:${typeof fields.floorMeta === 'number' ? fields.floorMeta : '?'} feet=${typeof fields.feetBlock === 'string' ? fields.feetBlock : '?'}:${typeof fields.feetMeta === 'number' ? fields.feetMeta : '?'} ` +
            `fwd=${Boolean(fields.forward)} jump=${Boolean(fields.jump)} sprint=${Boolean(fields.sprint)} ground=${Boolean(fields.onGround)} collisionAgo=${typeof fields.sinceHorizontalCollisionMs === 'number' ? `${fields.sinceHorizontalCollisionMs}ms` : '-'} ` +
            `ping=${typeof fields.pingMs === 'number' ? fields.pingMs+'ms' : '?'} correctionGap=${typeof fields.sinceCorrectionMs === 'number' ? fields.sinceCorrectionMs+'ms' : '-'} packets1s=${typeof fields.normalMovementPackets1s === 'number' ? fields.normalMovementPackets1s : '?'} gap=${typeof fields.minMovementPacketGapMs === 'number' ? fields.minMovementPacketGapMs : '?'}..${typeof fields.maxMovementPacketGapMs === 'number' ? fields.maxMovementPacketGapMs : '?'}ms bursts=${typeof fields.movementPacketBursts === 'number' ? fields.movementPacketBursts : '?'} step=${typeof fields.lastMovementStep === 'number' ? fields.lastMovementStep.toFixed(3) : '?'} maxStep=${typeof fields.maxMovementStep === 'number' ? fields.maxMovementStep.toFixed(3) : '?'} nearestSent=${typeof fields.nearestSentDistance === 'number' ? fields.nearestSentDistance.toFixed(3) : '?'}@${typeof fields.nearestSentAgeMs === 'number' ? fields.nearestSentAgeMs+'ms' : '-'}(${typeof fields.nearestSentPacketsAgo === 'number' ? fields.nearestSentPacketsAgo+'pkts' : '?'}) lastTargetDist=${typeof fields.lastSentTargetDistance === 'number' ? fields.lastSentTargetDistance.toFixed(3) : '?'} abilityWalk=${typeof fields.serverWalkingSpeed === 'number' ? fields.serverWalkingSpeed.toFixed(4) : '?'} abilityFly=${typeof fields.serverFlyingSpeed === 'number' ? fields.serverFlyingSpeed.toFixed(4) : '?'} abilityFlags=${typeof fields.serverAbilityFlags === 'number' ? fields.serverAbilityFlags : '?'} abilityAgo=${typeof fields.sinceServerAbilitiesMs === 'number' ? fields.sinceServerAbilitiesMs+'ms' : '-'} sprintActions2s=${typeof fields.sprintActions2s === 'number' ? fields.sprintActions2s : '?'} ` +
            `lastSprint=${typeof fields.lastSprintAction === 'string' ? fields.lastSprintAction : '-'}@${typeof fields.sinceSprintActionMs === 'number' ? fields.sinceSprintActionMs+'ms' : '-'} serverAttrAgo=${typeof fields.sinceServerMovementAttributeMs === 'number' ? fields.sinceServerMovementAttributeMs+'ms' : '-'} attrTargetDist=${typeof fields.serverMovementAttributeTargetDistance === 'number' ? fields.serverMovementAttributeTargetDistance.toFixed(3) : '?'} serverAttr=${typeof fields.serverMovementAttributeValue === 'number' ? fields.serverMovementAttributeValue.toFixed(4) : '?'} serverEffective=${typeof fields.serverMovementEffectiveSpeed === 'number' ? fields.serverMovementEffectiveSpeed.toFixed(4) : '?'} serverSprint=${typeof fields.serverMovementSprintModifier === 'boolean' ? fields.serverMovementSprintModifier : '?'} serverMods=${typeof fields.serverMovementModifiers === 'string' ? fields.serverMovementModifiers : '?'} ` +
            `velocityAgo=${typeof fields.sinceVelocityPacketMs === 'number' ? fields.sinceVelocityPacketMs+'ms' : '-'} serverVel=${typeof fields.serverVelocityX === 'number' ? fields.serverVelocityX.toFixed(3) : '?'},${typeof fields.serverVelocityY === 'number' ? fields.serverVelocityY.toFixed(3) : '?'},${typeof fields.serverVelocityZ === 'number' ? fields.serverVelocityZ.toFixed(3) : '?'}`
          : message === 'movement packet after correction'
            ? `seq=${typeof fields.correctionSequence === 'number' ? fields.correctionSequence : '?'} +${typeof fields.sinceCorrectionMs === 'number' ? fields.sinceCorrectionMs : '?'}ms packet=${typeof fields.packet === 'string' ? fields.packet : '?'} pos=${typeof fields.x === 'number' ? fields.x.toFixed(3) : '?'},${typeof fields.y === 'number' ? fields.y.toFixed(3) : '?'},${typeof fields.z === 'number' ? fields.z.toFixed(3) : '?'} yaw=${typeof fields.yaw === 'number' ? fields.yaw.toFixed(3) : '?'} pitch=${typeof fields.pitch === 'number' ? fields.pitch.toFixed(3) : '?'} ground=${typeof fields.onGround === 'boolean' ? fields.onGround : '?'} teleport=${typeof fields.teleportId === 'number' ? fields.teleportId : '-'} correctionAck=${Boolean(fields.correctionAck)}`
          : message === 'velocity packet after correction'
            ? `seq=${typeof fields.correctionSequence === 'number' ? fields.correctionSequence : '?'} +${typeof fields.sinceCorrectionMs === 'number' ? fields.sinceCorrectionMs : '?'}ms beforeVel=${typeof fields.beforeVelocityX === 'number' ? fields.beforeVelocityX.toFixed(3) : '?'},${typeof fields.beforeVelocityY === 'number' ? fields.beforeVelocityY.toFixed(3) : '?'},${typeof fields.beforeVelocityZ === 'number' ? fields.beforeVelocityZ.toFixed(3) : '?'} serverVel=${typeof fields.serverVelocityX === 'number' ? fields.serverVelocityX.toFixed(3) : '?'},${typeof fields.serverVelocityY === 'number' ? fields.serverVelocityY.toFixed(3) : '?'},${typeof fields.serverVelocityZ === 'number' ? fields.serverVelocityZ.toFixed(3) : '?'}`
          : message === 'physics tick after correction'
            ? `seq=${typeof fields.correctionSequence === 'number' ? fields.correctionSequence : '?'} +${typeof fields.sinceCorrectionMs === 'number' ? fields.sinceCorrectionMs : '?'}ms pos=${typeof fields.x === 'number' ? fields.x.toFixed(3) : '?'},${typeof fields.y === 'number' ? fields.y.toFixed(3) : '?'},${typeof fields.z === 'number' ? fields.z.toFixed(3) : '?'} vel=${typeof fields.velocityX === 'number' ? fields.velocityX.toFixed(3) : '?'},${typeof fields.velocityY === 'number' ? fields.velocityY.toFixed(3) : '?'},${typeof fields.velocityZ === 'number' ? fields.velocityZ.toFixed(3) : '?'} fwd=${Boolean(fields.forward)} jump=${Boolean(fields.jump)} sprint=${Boolean(fields.sprint)} ground=${Boolean(fields.onGround)}`
          : undefined });
    if (logs.length > 300) logs.shift();
    broadcast();
  });
  const snapshot = () => {
    const viewerUrl = runtimeViewerUrl(config) ?? config.viewer.publicUrl;
    return { version: 1, bots: manager.views(),
      instances: manager.registry.snapshot().map(r => ({ id: r.id, status: r.status, firstSeen: r.firstSeen, lastSeen: r.lastSeen })),
      jobs: manager.scheduler.snapshot().map(job => publicJob(job, manager.scheduler.attemptLimit)),
      performance: { runtime: performance.snapshot(), pathfinding: manager.performanceSnapshot() },
      carePackages: carePackages?.snapshot(),
      carePackageTracking: manager.carePackageTrackingSnapshot(), movementDebug: manager.movementDebugEnabled(),
      logs: [...logs], chatLogs: manager.chatDebugSnapshot(), serverConnection: controls?.getServer(), accounts: controls?.listAccounts(), viewer: config.viewer.enabled && viewerUrl
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
    const authChallenge = /^\/api\/v1\/accounts\/([0-9a-f-]{36})\/auth-challenge$/.exec(req.url ?? '');
    if (controls && req.method === 'GET' && authChallenge) {
      send(res, 200, { challenge: controls.getAuthChallenge(authChallenge[1]!) ?? null });
      return;
    }
    const match = /^\/api\/v1\/bots\/(bot-[1-9]\d*)\/actions\/(connect|join-pit|disconnect|test-launch-pad|test-care-package|oof)$/.exec(req.url ?? '');
    const fleetAction = /^\/api\/v1\/fleet\/actions\/(start-assigned|stop-all)$/.exec(req.url ?? '');
    const assignment = /^\/api\/v1\/bots\/(bot-[1-9]\d*)\/account$/.exec(req.url ?? '');
    const retry = /^\/api\/v1\/accounts\/([0-9a-f-]{36})\/actions\/retry-auth$/.exec(req.url ?? '');
    const sessionToken = /^\/api\/v1\/accounts\/([0-9a-f-]{36})\/session-token$/.exec(req.url ?? '');
    const accountDelete = /^\/api\/v1\/accounts\/([0-9a-f-]{36})$/.exec(req.url ?? '');
    const settingsWrite = !!controls && req.method === 'PUT' && req.url === '/api/v1/settings/server';
    const movementDebugWrite = req.method === 'PUT' && req.url === '/api/v1/settings/movement-debug';
    const accountWrite = !!controls && req.method === 'POST' && req.url === '/api/v1/accounts';
    const assignmentWrite = !!controls && req.method === 'PUT' && !!assignment;
    const retryWrite = !!controls && req.method === 'POST' && !!retry;
    const sessionTokenWrite = !!controls && req.method === 'PUT' && !!sessionToken;
    const jobWrite = req.method === 'POST' && req.url === '/api/v1/jobs';
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
    const fleetWrite = !!controls && req.method === 'POST' && !!fleetAction;
    if (!(req.method === 'POST' && match) && !settingsWrite && !movementDebugWrite && !accountWrite && !assignmentWrite && !retryWrite && !sessionTokenWrite && !fleetWrite && !jobWrite) { send(res, 404, { error: 'NOT_FOUND' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { send(res, 415, { error: 'CONTENT_TYPE' }); return; }
    let size = 0, body = '';
    const bodyLimit = accountWrite || sessionTokenWrite ? 8192 : jobWrite ? 2048 : 1024;
    req.on('data', chunk => { size += chunk.length; if (size <= bodyLimit) body += chunk.toString(); });
    req.on('end', () => { void (async () => {
      if (size > bodyLimit) { send(res, 413, { error: 'INVALID_BODY' }); return; }
      try {
        let data: unknown;
        try { data = JSON.parse(body); } catch { throw Error('INVALID_INPUT'); }
        if (settingsWrite) { const result = await controls!.saveServer(data); broadcast(); send(res, 200, result); return; }
        if (movementDebugWrite) {
          if (!data || typeof data !== 'object' || Array.isArray(data) ||
              Object.keys(data as Record<string,unknown>).join(',') !== 'enabled' ||
              typeof (data as {enabled?:unknown}).enabled !== 'boolean') throw Error('INVALID_INPUT');
          if (!manager.allStopped()) throw Error('INVALID_STATE');
          manager.setMovementDebug((data as {enabled:boolean}).enabled);
          broadcast(); send(res, 200, { enabled: manager.movementDebugEnabled() }); return;
        }
        if (accountWrite) { const result = await controls!.addAccount(data); broadcast(); send(res, 201, result); return; }
        if (jobWrite) {
          const now = Date.now();
          const event = manualJob(data, now);
          if (!manager.scheduler.enqueue(event, now)) throw Error('JOB_REJECTED');
          const job = manager.scheduler.jobs.get(event.id)!;
          broadcast(); send(res, 201, publicJob(job, manager.scheduler.attemptLimit)); return;
        }
        if (assignmentWrite) { const result = await controls!.assign(assignment![1]!, data); broadcast(); send(res, 200, result); return; }
        if (sessionTokenWrite) { const result = await controls!.replaceSessionToken(sessionToken![1]!, data); broadcast(); send(res, 200, result); return; }
        if (retryWrite) { if (JSON.stringify(data) !== '{}') throw Error('INVALID_INPUT'); const result = await controls!.retryAccount(retry![1]!); broadcast(); send(res, 200, result); return; }
        if (fleetWrite) {
          if (JSON.stringify(data) !== '{}') throw Error('INVALID_INPUT');
          if (controls!.busy) throw Error('CONFLICT');
          const result = fleetAction![1] === 'start-assigned' ? await controls!.startAssignedBots() : controls!.stopAllBots();
          broadcast(); send(res, 200, result); return;
        }
        if (JSON.stringify(data) !== '{}') throw Error('INVALID_INPUT');
        if (controls?.busy) throw Error('CONFLICT');
        const [, id, action] = match!;
        if (action === 'connect') {
          await controls?.prepareBotStart(id!);
          manager.connectBot(id!);
        }
        else if (action === 'join-pit') manager.joinPit(id!);
        else if (action === 'test-launch-pad') manager.testLaunchPad(id!);
        else if (action === 'test-care-package') manager.testCarePackage(id!);
        else if (action === 'oof') manager.oofBot(id!);
        else manager.disconnectBot(id!);
        broadcast(); send(res, 200, snapshot());
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const status = code === 'INVALID_INPUT' ? 400 : ['UNSUPPORTED_AUTH','UNSUPPORTED_ACTION','INVALID_SESSION_TOKEN','SESSION_AUTH_REQUIRED'].includes(code) ? 422 :
          ['UNKNOWN_BOT', 'UNKNOWN_ACCOUNT'].includes(code) ? 404 :
          ['INVALID_STATE', 'ACCOUNT_REQUIRED', 'CONFLICT', 'PROFILE_MISMATCH', 'JOB_REJECTED'].includes(code) ? 409 : 500;
        if (code === 'SESSION_AUTH_REQUIRED') broadcast();
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
    close: () => new Promise<void>(resolve => { clearInterval(timer); unsubscribe(); performance.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(() => resolve()); }),
    address: () => server.address()
  };
}

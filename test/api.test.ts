import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config/index.js';
import { BotManager } from '../src/bot/manager.js';
import { MockTransport } from '../src/bot/mock.js';
import { InstanceRegistry } from '../src/instances/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { PathfindingController } from '../src/pathfinding/controller.js';
import { MockTaskHandler } from '../src/events/task.js';
import { Logger } from '../src/logging/logger.js';
import { createManagementApi } from '../src/api/server.js';

test('management API enforces origin, state and input; WS sends safe snapshots', async () => {
  const config = loadConfig({ API_ENABLED: 'true', API_ORIGIN: 'http://localhost:5173', BOT_COUNT: '1' });
  config.api.port = 0;
  const logger = new Logger('info');
  const manager = new BotManager(config, (_index, events) => new MockTransport(events, () => 'mega'),
    new InstanceRegistry(), new Scheduler(3, 100, 100), new PathfindingController(1, 1000), new MockTaskHandler(), logger);
  const carePackages = {
    refresh: async () => {},
    snapshot: () => ({ source:'brookeafk.com' as const, sourceUrl:'https://brookeafk.com/', updatedAt:123,
      status:'OK' as const, events:[{timestamp:456}] })
  };
  const api = createManagementApi(manager, config, logger, undefined, carePackages);
  await api.listen();
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init,
    headers: { Origin: 'http://localhost:5173', ...(init.headers as Record<string,string> ?? {}) } });
  try {
    assert.equal((await fetch(base + '/api/v1/status', { headers: { Origin: 'http://evil.test' } })).status, 403);
    const status = await (await request('/api/v1/status')).json() as { bots: Array<{state:string}>; jobs:unknown[]; carePackages:{source:string;status:string;events:Array<{timestamp:number}>}; performance:{runtime:{cpuPercent:number;rssMb:number;eventLoopP99Ms:number};pathfinding:{active:number;queued:number;concurrency:number}}; movementDebug:boolean; viewer:unknown };
    assert.equal(status.bots[0]?.state, 'DISCONNECTED');
    assert.deepEqual(status.jobs, []);
    assert.equal(status.carePackages.source,'brookeafk.com');
    assert.deepEqual(status.carePackages.events,[{timestamp:456}]);
    assert.ok(Number.isFinite(status.performance.runtime.cpuPercent));
    assert.ok(status.performance.runtime.rssMb > 0);
    assert.ok(Number.isFinite(status.performance.runtime.eventLoopP99Ms));
    assert.equal(status.performance.pathfinding.active,0);
    assert.equal(status.performance.pathfinding.queued,0);
    assert.equal(status.performance.pathfinding.concurrency,1);
    assert.equal(status.viewer, null);
    assert.equal(status.movementDebug,false);
    const debugMode=(enabled:unknown)=>request('/api/v1/settings/movement-debug',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
    assert.equal((await debugMode('yes')).status,400);
    const enabledDebug=await debugMode(true);assert.equal(enabledDebug.status,200);assert.deepEqual(await enabledDebug.json(),{enabled:true});
    const disabledDebug=await debugMode(false);assert.equal(disabledDebug.status,200);assert.deepEqual(await disabledDebug.json(),{enabled:false});
    const action = (name:string, body='{}') => request(`/api/v1/bots/bot-1/actions/${name}`, {method:'POST',headers:{'Content-Type':'application/json'},body});
    assert.equal((await action('join-pit')).status, 409);
    assert.equal((await action('connect','{"command":"/play pit"}')).status, 400);
    assert.equal((await action('connect')).status, 200);
    assert.equal((await debugMode(true)).status,409);
    assert.equal((await action('connect')).status, 409);
    assert.equal((await action('join-pit')).status, 200);
    assert.equal((await action('join-pit')).status, 409);
    assert.equal((await action('test-launch-pad')).status, 200);
    assert.equal((await action('disconnect')).status, 200);
    assert.equal((await action('disconnect')).status, 409);
    assert.equal((await action('chat')).status, 404);
    const createJob=(body:unknown)=>request('/api/v1/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const expiresAt=Date.now()+60_000;
    assert.equal((await createJob({instanceId:'mega',eventType:'manual.test',target:{x:'1',y:64,z:2},expiresAt})).status,400);
    assert.equal((await createJob({instanceId:'mega',eventType:'manual.test',target:{x:1,y:64,z:2},expiresAt:Date.now()-1})).status,400);
    assert.equal((await createJob({instanceId:'mega',eventType:'manual.test',target:{x:1,y:64,z:2},expiresAt,command:'/stop'})).status,400);
    const createdJobResponse=await createJob({instanceId:'Mega-A',eventType:'manual.test',target:{x:1.5,y:64,z:-2},expiresAt});
    assert.equal(createdJobResponse.status,201);
    const createdJob=await createdJobResponse.json() as {id:string;instanceId:string;eventType:string;state:string;x:number;y:number;z:number;attempts:number;maxAttempts:number;lastFailure?:string;retryAt?:number};
    assert.match(createdJob.id,/^manual-[0-9a-f-]{36}$/);
    assert.deepEqual({instanceId:createdJob.instanceId,eventType:createdJob.eventType,state:createdJob.state,x:createdJob.x,y:createdJob.y,z:createdJob.z},
      {instanceId:'mega-a',eventType:'manual.test',state:'QUEUED',x:1.5,y:64,z:-2});
    assert.equal(createdJob.attempts,0);
    assert.equal(createdJob.maxAttempts,3);
    assert.equal(createdJob.lastFailure,undefined);
    assert.equal(createdJob.retryAt,undefined);
    const jobStatus=await (await request('/api/v1/status')).json() as {jobs:Array<{id:string}>};
    assert.equal(jobStatus.jobs.some(job=>job.id===createdJob.id),true);
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/v1/events', {origin:'http://localhost:5173'});
    const packet = await new Promise<string>((resolve,reject) => { ws.once('message', data => resolve(data.toString())); ws.once('error',reject); });
    assert.equal(JSON.parse(packet).type,'snapshot');
    ws.close();
  } finally { manager.stop(); await api.close(); }
});

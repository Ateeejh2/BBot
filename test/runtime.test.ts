import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config/index.js';
import { BotManager } from '../src/bot/manager.js';
import { MockTransport } from '../src/bot/mock.js';
import { InstanceRegistry } from '../src/instances/registry.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { PathfindingController } from '../src/pathfinding/controller.js';
import { MockTaskHandler } from '../src/events/task.js';
import { Logger } from '../src/logging/logger.js';
import { ControlStore } from '../src/runtime/control.js';
import { createManagementApi } from '../src/api/server.js';

test('runtime settings and accounts stay scoped, persisted and secret-free', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.test-control-'));
  const config = loadConfig({ MODE:'live', API_ENABLED:'true', API_ORIGIN:'http://localhost:5173',
    ACCOUNTS_FILE:join(dir,'missing.json'), DATA_DIR:dir, SERVER_HOST:'fallback.example', SERVER_PORT:'25565' });
  config.api.port = 0;
  const authSecret = 'SECRET_REFRESH_TOKEN_987654321';
  const controls = new ControlStore(config, async account => {
    if (account.label === 'Failure') throw Error(authSecret);
    return account.label === 'Scout' ? { minecraftName: 'RealScout' } : {};
  });
  await controls.load();
  const captured: Array<{host:string;port:number;username:string;label:string}> = [];
  const logger = new Logger('error');
  const manager = new BotManager(config, (index, events) => {
    captured.push({host:config.host,port:config.port,username:config.accounts[index]!.username,label:config.accounts[index]!.label});
    return new MockTransport(events, () => 'mega');
  }, new InstanceRegistry(), new Scheduler(3,100,100), new PathfindingController(1,1000), new MockTaskHandler(), logger);
  await controls.bind(manager);
  const api = createManagementApi(manager, config, logger, controls);
  await api.listen();
  const address = api.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path:string)=>fetch(base+path,{headers:{Origin:'http://localhost:5173'}});
  const write=(path:string,method:'POST'|'PUT',body:unknown)=>fetch(base+path,{method,
    headers:{Origin:'http://localhost:5173','Content-Type':'application/json'},body:JSON.stringify(body)});
  const del=(path:string)=>fetch(base+path,{method:'DELETE',headers:{Origin:'http://localhost:5173'}});
  try {
    assert.equal((await (await get('/api/v1/settings/server')).json() as {host:string}).host,'fallback.example');
    assert.equal((await (await get('/api/v1/accounts')).json() as {accounts:unknown[]}).accounts.length,0);
    assert.equal((await write('/api/v1/bots/bot-1/actions/connect','POST',{})).status,409);
    for(const host of ['https://server.example','server.example:25565','bad/a','999.2.3.4','a..b'])
      assert.equal((await write('/api/v1/settings/server','PUT',{host,port:25565,version:'1.8.9'})).status,400);
    for(const port of [0,65536,'25565',1.5])
      assert.equal((await write('/api/v1/settings/server','PUT',{host:'play.example.com',port,version:'1.8.9'})).status,400);
    assert.equal((await write('/api/v1/settings/server','PUT',{host:'play.example.com',port:25566,version:'1.8.9',url:'http://other'})).status,400);
    assert.equal((await write('/api/v1/settings/server','PUT',{host:'play.example.com',port:25566,version:'1.8.9'})).status,200);
    assert.equal((await write('/api/v1/accounts','POST',{kind:'SESSION',label:'Legacy',credential:authSecret})).status,422);
    assert.equal((await write('/api/v1/accounts','POST',{kind:'MICROSOFT',label:'../bad'})).status,400);
    assert.equal((await write('/api/v1/accounts','POST',{kind:'MICROSOFT',label:'Scout',token:authSecret})).status,400);
    const created = await (await write('/api/v1/accounts','POST',{kind:'MICROSOFT',label:'Scout'})).json() as {id:string};
    await new Promise(resolve=>setTimeout(resolve,10));
    const publicAccounts = await (await get('/api/v1/accounts')).json() as {accounts:Array<{id:string;minecraftName?:string;assignedBot?:string}>};
    assert.equal(publicAccounts.accounts.find(a=>a.id===created.id)?.minecraftName,'RealScout');
    assert.equal(publicAccounts.accounts.find(a=>a.id===created.id)?.assignedBot,'bot-1');
    assert.equal(manager.views()[0]?.accountId,created.id);
    assert.equal(manager.views()[0]?.minecraftName,'RealScout');
    assert.equal((await write('/api/v1/bots/bot-1/account','PUT',{accountId:created.id})).status,200);
    await manager.withConfigurationLock(() => manager.allDisconnected(), async () => {
      assert.equal((await write('/api/v1/bots/bot-1/actions/connect','POST',{})).status,409);
      manager.tick(); assert.equal(manager.views()[0]?.state,'DISCONNECTED');
    });
    assert.equal((await write('/api/v1/bots/bot-1/actions/connect','POST',{})).status,200);
    assert.deepEqual(captured[0],{host:'play.example.com',port:25566,username:'Scout',label:'Scout'});
    assert.equal((await write('/api/v1/settings/server','PUT',{host:'other.example',port:25565,version:'1.8.9'})).status,409);
    assert.equal((await write('/api/v1/bots/bot-1/account','PUT',{accountId:created.id})).status,409);
    assert.equal((await del(`/api/v1/accounts/${created.id}`)).status,409);
    assert.equal((await write('/api/v1/bots/bot-1/actions/disconnect','POST',{})).status,200);
    assert.equal((await write('/api/v1/bots/bot-1/account','PUT',{accountId:null})).status,200);
    assert.equal(manager.views()[0]?.accountId,undefined);
    assert.equal((await write('/api/v1/bots/bot-1/account','PUT',{accountId:created.id})).status,200);
    const disposable = await (await write('/api/v1/accounts','POST',{kind:'MICROSOFT',label:'DeleteMe'})).json() as {id:string};
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await write('/api/v1/bots/bot-1/account','PUT',{accountId:disposable.id})).status,200);
    assert.equal((await del(`/api/v1/accounts/${disposable.id}`)).status,200);
    assert.equal(manager.views()[0]?.accountId,undefined);
    assert.equal((await (await get('/api/v1/accounts')).text()).includes(disposable.id),false);
    assert.equal((await write('/api/v1/bots/bot-1/account','PUT',{accountId:created.id})).status,200);
    const ws = new WebSocket(base.replace('http:','ws:')+'/api/v1/events',{origin:'http://localhost:5173'});
    const packet=await new Promise<string>((resolve,reject)=>{ws.once('message',d=>resolve(d.toString()));ws.once('error',reject)});
    ws.close();
    assert.equal(packet.includes(authSecret),false);
    const fail=await write('/api/v1/accounts','POST',{kind:'MICROSOFT',label:'Failure'});
    assert.equal(fail.status,201);
    const failedAccount=await fail.json() as {id:string};
    await new Promise(resolve=>setTimeout(resolve,10));
    const status=await (await get('/api/v1/status')).text();
    assert.equal(status.includes(authSecret),false);
    assert.ok(status.includes('ERROR'));
    assert.equal((await write(`/api/v1/accounts/${failedAccount.id}/actions/retry-auth`,'POST',{})).status,200);
    const disk=await readFile(join(dir,'accounts-runtime.json'),'utf8');
    assert.equal(disk.includes(authSecret),false);
    const persisted=new ControlStore(loadConfig({MODE:'live',API_ENABLED:'true',API_ORIGIN:'http://localhost:5173',
      ACCOUNTS_FILE:join(dir,'missing.json'),DATA_DIR:dir}),async()=>{});
    await persisted.load();
    assert.equal(persisted.getServer().host,'play.example.com');
    assert.equal(persisted.listAccounts().find(a=>a.id===created.id)?.assignedBot,'bot-1');
  } finally { manager.stop();await api.close();await rm(dir,{recursive:true,force:true}); }
});

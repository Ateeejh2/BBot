import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
import { createBotOptions } from '../src/bot/mineflayer.js';
import { resolveSessionCredential } from '../src/runtime/session.js';

test('runtime settings and accounts stay scoped, persisted and secret-free', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.test-control-'));
  const config = loadConfig({ MODE:'live', API_ENABLED:'true', API_ORIGIN:'http://localhost:5173',
    ACCOUNTS_FILE:join(dir,'missing.json'), DATA_DIR:dir, SERVER_HOST:'fallback.example', SERVER_PORT:'25565' });
  config.api.port = 0;
  config.authDir = join(dir,'.auth');
  const authSecret = 'SECRET_REFRESH_TOKEN_987654321';
  const sessionSecret = 'TEST_SESSION_ACCESS_24680';
  const replacementSecret = 'TEST_SESSION_ACCESS_REPLACED_86420';
  const recoverySecret = 'TEST_SESSION_ACCESS_RECOVERY_97531';
  const otherProfileSecret = 'TEST_OTHER_PROFILE_11223';
  const invalidSessionTokens = new Set<string>();
  const controls = new ControlStore(config, async account => {
    if (account.label === 'Failure') throw Error(authSecret);
    return account.label === 'Scout' ? { minecraftName: 'RealScout' } : {};
  }, async token => {
    if (invalidSessionTokens.has(token)) throw Error('INVALID_SESSION_TOKEN');
    if (token === sessionSecret) return { accessToken: token, selectedProfile: { name: 'SessionMC', id: '12345678123412341234123456789abc' } };
    if (token === replacementSecret) return { accessToken: token, selectedProfile: { name: 'SessionMC2', id: '12345678123412341234123456789abc' } };
    if (token === recoverySecret) return { accessToken: token, selectedProfile: { name: 'SessionMC3', id: '12345678123412341234123456789abc' } };
    if (token === otherProfileSecret) return { accessToken: token, selectedProfile: { name: 'OtherMC', id: 'abcdefabcdefabcdefabcdefabcdefab' } };
    throw Error('INVALID_SESSION_TOKEN');
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
    assert.equal((await write('/api/v1/accounts','POST',{kind:'SESSION',label:'Legacy',credential:authSecret})).status,400);
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
    const input={kind:'SESSION',label:'SessionOne',accessToken:sessionSecret};
    for(const invalid of [ {...input,accessToken:''}, {...input,extra:'unwanted'},
      {kind:'SESSION',label:'SessionOne',accessToken:sessionSecret,profileName:'should-not-be-sent'} ])
      assert.equal((await write('/api/v1/accounts','POST',invalid)).status,400);
    assert.equal((await write('/api/v1/accounts','POST',{kind:'SESSION',label:'BadToken',accessToken:'BAD_TOKEN'})).status,422);
    const sessionResponse=await write('/api/v1/accounts','POST',input);
    assert.equal(sessionResponse.status,201);
    const account=await sessionResponse.json() as {id:string;kind:string;status:string;assignedBot?:string};
    assert.equal(account.kind,'SESSION');assert.equal(account.status,'READY');
    assert.equal(JSON.stringify(account).includes(sessionSecret),false);
    const file=join(config.authDir,'session',`${account.id}.json`);
    assert.equal((await readFile(file,'utf8')).includes(sessionSecret),true);
    if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
    assert.equal((await readFile(join(dir,'accounts-runtime.json'),'utf8')).includes(sessionSecret),false);
    assert.equal((await (await get('/api/v1/accounts')).text()).includes(sessionSecret),false);
    assert.equal((await (await get('/api/v1/status')).text()).includes(sessionSecret),false);
    const sessionWs=new WebSocket(base.replace('http:','ws:')+'/api/v1/events',{origin:'http://localhost:5173'});
    const sessionPacket=await new Promise<string>((resolve,reject)=>{sessionWs.once('message',d=>resolve(d.toString()));sessionWs.once('error',reject)});
    sessionWs.close();assert.equal(sessionPacket.includes(sessionSecret),false);
    assert.equal((await write('/api/v1/bots/bot-1/account','PUT',{accountId:account.id})).status,200);
    assert.equal(manager.views()[0]?.minecraftName,'SessionMC');
    assert.equal((await write(`/api/v1/accounts/${account.id}/session-token`,'PUT',{accessToken:otherProfileSecret})).status,409);
    assert.equal((await write(`/api/v1/accounts/${account.id}/session-token`,'PUT',{accessToken:'BAD_TOKEN'})).status,422);
    assert.equal((await write(`/api/v1/accounts/${account.id}/session-token`,'PUT',{accessToken:replacementSecret,extra:true})).status,400);
    assert.equal((await write(`/api/v1/accounts/${account.id}/session-token`,'PUT',{accessToken:replacementSecret})).status,200);
    assert.equal(manager.views()[0]?.minecraftName,'SessionMC2');
    const replacedFile=await readFile(file,'utf8');
    assert.equal(replacedFile.includes(replacementSecret),true);
    assert.equal(replacedFile.includes(sessionSecret),false);
    assert.equal((await (await get('/api/v1/status')).text()).includes(replacementSecret),false);
    const options=createBotOptions(config,0);
    assert.equal(options.auth,'mojang');assert.equal(options.skipValidation,true);
    assert.equal(options.profilesFolder,false);assert.equal(options.onMsaCode,undefined);
    assert.equal(options.session?.accessToken,replacementSecret);
    assert.equal(options.session?.selectedProfile.id,'12345678123412341234123456789abc');
    assert.equal(options.session?.selectedProfile.name,'SessionMC2');
    assert.equal(options.session?.clientToken,undefined);
    assert.equal((await write('/api/v1/bots/bot-1/actions/connect','POST',{})).status,200);
    assert.equal((await write(`/api/v1/accounts/${account.id}/session-token`,'PUT',{accessToken:sessionSecret})).status,409);
    assert.equal((await del(`/api/v1/accounts/${account.id}`)).status,409);
    assert.equal((await write('/api/v1/bots/bot-1/actions/disconnect','POST',{})).status,200);
    invalidSessionTokens.add(replacementSecret);
    const expiredStart=await write('/api/v1/bots/bot-1/actions/connect','POST',{});
    assert.equal(expiredStart.status,422);
    assert.equal((await expiredStart.json() as {error:string}).error,'SESSION_AUTH_REQUIRED');
    const errored=(await (await get('/api/v1/accounts')).json() as {accounts:Array<{id:string;status:string;authError?:string}>})
      .accounts.find(a=>a.id===account.id)!;
    assert.equal(errored.status,'ERROR');assert.equal(errored.authError,'SESSION_TOKEN_INVALID');
    assert.equal(manager.views()[0]?.state,'DISCONNECTED');
    const recovered=await write(`/api/v1/accounts/${account.id}/session-token`,'PUT',{accessToken:recoverySecret});
    assert.equal(recovered.status,200);
    const recoveredAccount=await recovered.json() as {status:string;authError?:string;minecraftName?:string};
    assert.equal(recoveredAccount.status,'READY');assert.equal(recoveredAccount.authError,undefined);
    assert.equal(recoveredAccount.minecraftName,'SessionMC3');
    const recoveredOptions=createBotOptions(config,0);
    assert.equal(recoveredOptions.session?.selectedProfile.name,'SessionMC3');
    assert.equal(recoveredOptions.session?.accessToken,recoverySecret);
    assert.equal((await write('/api/v1/bots/bot-1/actions/connect','POST',{})).status,200);
    assert.equal((await write('/api/v1/bots/bot-1/actions/disconnect','POST',{})).status,200);
    assert.equal((await del(`/api/v1/accounts/${account.id}`)).status,200);
    await assert.rejects(stat(file),{code:'ENOENT'});
    assert.equal(manager.views()[0]?.accountId,undefined);
  } finally { manager.stop();await api.close();await rm(dir,{recursive:true,force:true}); }
});

test('two READY Microsoft accounts start assigned with spacing, enter separate instances, and stop all', async () => {
  const dir=await mkdtemp(join(process.cwd(),'.test-fleet-two-'));
  let now=0;
  const config=loadConfig({MODE:'live',BOT_COUNT:'2',API_ENABLED:'true',API_ORIGIN:'http://localhost:5173',
    ACCOUNTS_FILE:join(dir,'missing.json'),DATA_DIR:dir,CONNECTION_SPACING_MS:'100',PLAY_COOLDOWN_MS:'1000'});
  config.authDir=join(dir,'.auth');
  const controls=new ControlStore(config,async account=>({minecraftName:`${account.label}MC`}));
  const logger=new Logger('error');
  const transports:MockTransport[]=[];
  const manager=new BotManager(config,(index,events)=>{
    const transport=new MockTransport(events,()=>index===0?'mega-a':'mega-b');
    transports.push(transport);
    return transport;
  },new InstanceRegistry(),new Scheduler(3,100,100),new PathfindingController(2,1000),new MockTaskHandler(),logger,()=>now,()=>1);
  try {
    await controls.load();await controls.bind(manager);
    const first=await controls.addAccount({kind:'MICROSOFT',label:'First'});
    const second=await controls.addAccount({kind:'MICROSOFT',label:'Second'});
    await delay(10);
    const accounts=controls.listAccounts();
    assert.ok(accounts.every(a=>a.status==='READY'));
    await controls.assign('bot-1',{accountId:first.id});
    await controls.assign('bot-2',{accountId:second.id});
    const started=await controls.startAssignedBots();
    assert.deepEqual(started,{started:['bot-1','bot-2'],skipped:[]});
    await delay(0);
    assert.equal(transports.length,1);
    assert.equal(manager.views()[0]?.state,'LOBBY');
    assert.equal(manager.views()[1]?.startQueued,true);
    now=99;manager.tick();assert.equal(transports.length,1);
    now=100;manager.tick();await delay(0);
    assert.equal(transports.length,2);
    assert.equal(manager.views()[1]?.state,'LOBBY');
    now=1000;manager.tick();
    assert.equal(manager.views()[0]?.state,'IN_PIT_IDLE');
    assert.equal(manager.views()[0]?.instanceId,'mega-a');
    assert.equal(manager.views()[1]?.state,'LOBBY');
    now=1100;manager.tick();
    assert.equal(manager.views()[1]?.state,'IN_PIT_IDLE');
    assert.equal(manager.views()[1]?.instanceId,'mega-b');
    assert.deepEqual(controls.stopAllBots().stopped.sort(),['bot-1','bot-2']);
    assert.ok(manager.views().every(bot=>bot.state==='DISCONNECTED'&&!bot.startQueued));
  } finally {manager.stop();await rm(dir,{recursive:true,force:true});}
});

test('one READY Session account auto assigns and stays credential-free on restart', async () => {
  const dir=await mkdtemp(join(process.cwd(),'.test-session-auto-'));
  const config=loadConfig({MODE:'live',API_ENABLED:'true',API_ORIGIN:'http://localhost:5173',ACCOUNTS_FILE:join(dir,'missing.json'),DATA_DIR:dir});
  config.authDir=join(dir,'.auth');
  const controls=new ControlStore(config,async()=>{},async token=>({
    accessToken:token,selectedProfile:{name:'MCName',id:'12345678123412341234123456789abc'}
  }));
  const logger=new Logger('error');
  const manager=new BotManager(config,(_index,events)=>new MockTransport(events,()=> 'mega'),
    new InstanceRegistry(),new Scheduler(3,100,100),new PathfindingController(1,1000),new MockTaskHandler(),logger);
  try {
    await controls.load();await controls.bind(manager);
    const account=await controls.addAccount({kind:'SESSION',label:'SessionOnly',accessToken:'TEST_ACCESS'});
    assert.equal(account.assignedBot,'bot-1');assert.equal(manager.views()[0]?.accountId,account.id);
    const next=new ControlStore(config,async()=>{});await next.load();
    assert.equal(next.listAccounts()[0]?.assignedBot,'bot-1');
    assert.equal(JSON.stringify(next.listAccounts()).includes('TEST_ACCESS'),false);
  } finally {manager.stop();await rm(dir,{recursive:true,force:true});}
});


test('Minecraft access token resolves MCID and UUID without client token', async () => {
  let authorization='';
  const credential=await resolveSessionCredential('MC_ACCESS_TOKEN', async (_input,init) => {
    authorization=String((init?.headers as Record<string,string>)?.Authorization??'');
    return new Response(JSON.stringify({id:'abcdefabcdefabcdefabcdefabcdefab',name:'TokenUser'}), {
      status:200,headers:{'content-type':'application/json'}
    });
  });
  assert.equal(authorization,'Bearer MC_ACCESS_TOKEN');
  assert.deepEqual(credential,{
    accessToken:'MC_ACCESS_TOKEN',
    selectedProfile:{id:'abcdefabcdefabcdefabcdefabcdefab',name:'TokenUser'}
  });
  assert.equal(credential.clientToken,undefined);
});

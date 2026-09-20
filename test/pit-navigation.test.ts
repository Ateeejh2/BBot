import test from 'node:test';
import assert from 'node:assert/strict';
import { PitNavigationService, type PitChunkData } from '../src/pathfinding/pit-navigation.js';

const STONE=1;
const COBBLESTONE=4;
const OAK_PLANK=5;
const BEDROCK=7;
const OBSIDIAN=49;

function chunkWithWall(includeWall=true):PitChunkData {
  const sections=new Map<number,Uint16Array>();
  const set=(x:number,y:number,z:number,state:number)=>{
    const sy=y>>4;
    let values=sections.get(sy);
    if(!values){values=new Uint16Array(4096);sections.set(sy,values);}
    values[((y&15)*256)+(z*16)+x]=state;
  };

  for(let x=0;x<16;x++)for(let z=0;z<16;z++)set(x,63,z,STONE);
  if(includeWall)for(let z=0;z<=9;z++){
    if(z===7)continue;
    set(5,64,z,STONE);
    set(5,65,z,STONE);
  }
  return {
    chunkX:0,
    chunkZ:0,
    sections:[...sections.entries()].map(([y,states])=>({y,states}))
  };
}

function flatChunk(chunkX:number, floorY=63):PitChunkData {
  const sections=new Map<number,Uint16Array>();
  const set=(x:number,y:number,z:number,state:number)=>{
    const sy=y>>4;
    let values=sections.get(sy);
    if(!values){values=new Uint16Array(4096);sections.set(sy,values);}
    values[((y&15)*256)+(z*16)+x]=state;
  };
  for(let x=0;x<16;x++)for(let z=0;z<16;z++)set(x,floorY,z,STONE);
  return {chunkX,chunkZ:0,sections:[...sections.entries()].map(([y,states])=>({y,states}))};
}

function volatileBarrierChunk(stateId=OBSIDIAN):PitChunkData {
  const chunk=flatChunk(0);
  const sections=new Map(chunk.sections.map(section=>[section.y,section.states.slice()] as const));
  const set=(x:number,y:number,z:number,state:number)=>{
    const sy=y>>4;
    let values=sections.get(sy);
    if(!values){values=new Uint16Array(4096);sections.set(sy,values);}
    values[((y&15)*256)+(z*16)+x]=state;
  };
  set(5,64,2,stateId);
  set(5,65,2,stateId);
  return {chunkX:0,chunkZ:0,sections:[...sections.entries()].map(([y,states])=>({y,states}))};
}

function dropChunk():PitChunkData {
  const sections=new Map<number,Uint16Array>();
  const set=(x:number,y:number,z:number,state:number)=>{
    const sy=y>>4;
    let values=sections.get(sy);
    if(!values){values=new Uint16Array(4096);sections.set(sy,values);}
    values[((y&15)*256)+(z*16)+x]=state;
  };
  for(let x=0;x<16;x++)for(let z=0;z<16;z++){
    if(x<=4)set(x,79,z,STONE);
    else set(x,63,z,STONE);
  }
  return {chunkX:0,chunkZ:0,sections:[...sections.entries()].map(([y,states])=>({y,states}))};
}

test('cached Pit A-star routes around a blocking wall instead of walking into it', async () => {
  const service=new PitNavigationService();
  const terrain=chunkWithWall();
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined> =>
    x===0&&z===0?terrain:undefined;
  const signal=new AbortController().signal;

  const plan=await service.plan('mega-a',{x:2.5,y:64,z:2.5},{x:9.5,y:64,z:2.5},loader,signal);
  assert.equal(plan.complete,true);
  assert.ok(plan.waypoints.length>=3);
  assert.ok(plan.waypoints.some(point=>point.z>=7.5),'path should use the wall opening near z=7');
  assert.ok(plan.expandedNodes>0);
});

test('runtime collision cells are excluded from the next A-star replan', async () => {
  const service=new PitNavigationService();
  const terrain=chunkWithWall();
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined> =>
    x===0&&z===0?terrain:undefined;
  const signal=new AbortController().signal;
  const plan=await service.plan(
    'mega-a',
    {x:2.5,y:64,z:2.5},
    {x:9.5,y:64,z:2.5},
    loader,
    signal,
    [{x:5,z:7}]
  );
  assert.equal(plan.complete,true);
  assert.ok(plan.waypoints.some(point=>point.z>=10.5),'replan should route around the blocked opening');
});

test('first fingerprint scans every loaded chunk once and later paths reuse the graph', async () => {
  const service=new PitNavigationService();
  const chunks=new Map<number,PitChunkData>([
    [0,flatChunk(0)],[1,flatChunk(1)],[2,flatChunk(2)]
  ]);
  let listCalls=0,loadCalls=0;
  const progress:Array<{done:number;total:number}>=[];
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined>=>{
    loadCalls++;
    return z===0?chunks.get(x):undefined;
  };
  const lister=async()=>{
    listCalls++;
    return [{x:0,z:0},{x:1,z:0},{x:2,z:0}];
  };
  const signal=new AbortController().signal;

  const first=await service.plan(
    'mega-full',
    {x:2.5,y:64,z:2.5},
    {x:40.5,y:64,z:2.5},
    loader,
    signal,
    [],
    lister,
    (done,total)=>progress.push({done,total})
  );
  assert.equal(first.complete,true);
  assert.equal(first.scannedChunks,3);
  assert.equal(listCalls,1);
  assert.deepEqual(progress[0],{done:0,total:3});
  assert.deepEqual(progress.at(-1),{done:3,total:3});
  const afterFirst=loadCalls;

  const second=await service.plan(
    'mega-full',
    {x:3.5,y:64,z:2.5},
    {x:39.5,y:64,z:2.5},
    loader,
    signal,
    [],
    lister,
    (done,total)=>progress.push({done,total})
  );
  assert.equal(second.complete,true);
  assert.equal(listCalls,1);
  assert.equal(loadCalls,afterFirst);
  assert.equal(progress.length,3);
});

test('A-star allows arbitrarily deep Pit drops when a lower floor exists', async () => {
  const service=new PitNavigationService();
  const terrain=dropChunk();
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined> =>
    x===0&&z===0?terrain:undefined;
  const signal=new AbortController().signal;

  const plan=await service.plan(
    'mega-drop',
    {x:2.5,y:80,z:2.5},
    {x:10.5,y:64,z:2.5},
    loader,
    signal
  );
  assert.equal(plan.complete,true);
  assert.ok(plan.waypoints.some(point=>point.y===64));
});

test('volatile Pit blocks do not change the shared terrain fingerprint', async () => {
  const service=new PitNavigationService();
  const signal=new AbortController().signal;
  const start={x:2.5,y:64,z:2.5},target={x:9.5,y:64,z:2.5};
  const states=[OBSIDIAN,COBBLESTONE,BEDROCK,OAK_PLANK];
  const fingerprints:string[]=[];
  const clearPlan=await service.plan(
    'volatile-clear',
    start,
    target,
    async (x,z)=>x===0&&z===0?flatChunk(0):undefined,
    signal
  );
  fingerprints.push(clearPlan.fingerprint);
  for(let i=0;i<states.length;i++){
    const terrain=volatileBarrierChunk(states[i]!);
    const plan=await service.plan(
      `volatile-${i}`,
      start,
      target,
      async (x,z)=>x===0&&z===0?terrain:undefined,
      signal
    );
    fingerprints.push(plan.fingerprint);
  }
  assert.equal(new Set(fingerprints).size,1);
});

test('shared base graph keeps volatile obstacles instance-local', async () => {
  const service=new PitNavigationService();
  const clear=flatChunk(0);
  const blocked=volatileBarrierChunk();
  const signal=new AbortController().signal;
  const start={x:2.5,y:64,z:2.5},target={x:9.5,y:64,z:2.5};
  const lister=async()=>[{x:0,z:0}];

  const clearPlan=await service.plan(
    'clear-instance',
    start,
    target,
    async (x,z)=>x===0&&z===0?clear:undefined,
    signal,
    [],
    lister,
    undefined,
    async()=>[]
  );
  const blockedPlan=await service.plan(
    'blocked-instance',
    start,
    target,
    async (x,z)=>x===0&&z===0?blocked:undefined,
    signal,
    [],
    lister,
    undefined,
    async()=>[
      {x:5,y:64,z:2,stateId:OBSIDIAN},
      {x:5,y:65,z:2,stateId:OBSIDIAN}
    ]
  );

  assert.equal(clearPlan.fingerprint,blockedPlan.fingerprint);
  assert.equal(service.cache.snapshot(Date.now()).length,1);
  assert.equal(clearPlan.dynamicBlocks,0);
  assert.equal(blockedPlan.dynamicBlocks,2);
  assert.ok(clearPlan.waypoints.every(point=>point.z===2.5),'clear instance should use the straight route');
  assert.ok(blockedPlan.waypoints.some(point=>point.z!==2.5),'blocked instance should route around its own overlay');

  const clearAgain=await service.plan(
    'clear-instance',
    start,
    target,
    async (x,z)=>x===0&&z===0?clear:undefined,
    signal,
    [],
    lister,
    undefined,
    async()=>[]
  );
  assert.equal(clearAgain.dynamicBlocks,0);
  assert.ok(clearAgain.waypoints.every(point=>point.z===2.5),'blocked overlay must not leak into another instance');
});

test('live volatile block placement and removal changes only the instance overlay', async () => {
  const service=new PitNavigationService();
  const terrain=flatChunk(0);
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined> =>
    x===0&&z===0?terrain:undefined;
  const signal=new AbortController().signal;
  const start={x:2.5,y:64,z:2.5},target={x:9.5,y:64,z:2.5};

  const initial=await service.plan('live-instance',start,target,loader,signal);
  service.updateDynamicBlock('live-instance',{x:5,y:64,z:2},OBSIDIAN);
  service.updateDynamicBlock('live-instance',{x:5,y:65,z:2},OBSIDIAN);
  const blocked=await service.plan('live-instance',start,target,loader,signal);
  assert.ok(blocked.overlayRevision>initial.overlayRevision);
  assert.equal(blocked.dynamicBlocks,2);
  assert.ok(blocked.waypoints.some(point=>point.z!==2.5));

  service.updateDynamicBlock('live-instance',{x:5,y:64,z:2},0);
  service.updateDynamicBlock('live-instance',{x:5,y:65,z:2},0);
  const restored=await service.plan('live-instance',start,target,loader,signal);
  assert.ok(restored.overlayRevision>blocked.overlayRevision);
  assert.equal(restored.dynamicBlocks,0);
  assert.ok(restored.waypoints.every(point=>point.z===2.5));
});

test('shared live overlay skips rescanning while another bot still watches the instance', async () => {
  const service=new PitNavigationService();
  const terrain=flatChunk(0);
  const signal=new AbortController().signal;
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined> =>
    x===0&&z===0?terrain:undefined;
  const lister=async()=>[{x:0,z:0}];
  let dynamicCalls=0;
  const dynamicLoader=async()=>{dynamicCalls++;return [];};

  service.retainInstance('watched-instance',{x:2.5,y:64,z:2.5});
  service.retainInstance('watched-instance',{x:2.5,y:64,z:2.5});
  await service.plan(
    'watched-instance',{x:2.5,y:64,z:2.5},{x:9.5,y:64,z:2.5},
    loader,signal,[],lister,undefined,dynamicLoader
  );
  const afterInitialScan=dynamicCalls;

  service.releaseInstance('watched-instance');
  await service.plan(
    'watched-instance',{x:2.5,y:64,z:2.5},{x:9.5,y:64,z:2.5},
    loader,signal,[],lister,undefined,dynamicLoader
  );

  assert.equal(dynamicCalls,afterInitialScan);
});

test('first bot after an unwatched gap rescans the instance overlay exactly once', async () => {
  const service=new PitNavigationService();
  const terrain=flatChunk(0);
  const signal=new AbortController().signal;
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined> =>
    x===0&&z===0?terrain:undefined;
  const lister=async()=>[{x:0,z:0}];
  let dynamicCalls=0;
  let dynamic:Array<{x:number;y:number;z:number;stateId:number}>=[];
  const dynamicLoader=async()=>{dynamicCalls++;return dynamic;};

  service.retainInstance('gap-instance',{x:2.5,y:64,z:2.5});
  await service.plan(
    'gap-instance',{x:2.5,y:64,z:2.5},{x:9.5,y:64,z:2.5},
    loader,signal,[],lister,undefined,dynamicLoader
  );
  const initialCalls=dynamicCalls;
  service.releaseInstance('gap-instance');

  dynamic=[
    {x:5,y:64,z:2,stateId:OBSIDIAN},
    {x:5,y:65,z:2,stateId:OBSIDIAN}
  ];
  service.retainInstance('gap-instance',{x:2.5,y:64,z:2.5});
  const changed=await service.plan(
    'gap-instance',{x:2.5,y:64,z:2.5},{x:9.5,y:64,z:2.5},
    loader,signal,[],lister,undefined,dynamicLoader
  );

  assert.equal(dynamicCalls,initialCalls+1);
  assert.equal(changed.dynamicBlocks,2);
  assert.ok(changed.waypoints.some(point=>point.z!==2.5));

  const again=await service.plan(
    'gap-instance',{x:2.5,y:64,z:2.5},{x:9.5,y:64,z:2.5},
    loader,signal,[],lister,undefined,dynamicLoader
  );
  assert.equal(dynamicCalls,initialCalls+1);
  assert.equal(again.dynamicBlocks,2);
});

test('world reset invalidates the instance overlay and rescans only current volatile blocks', async () => {
  const service=new PitNavigationService();
  const terrain=flatChunk(0);
  const signal=new AbortController().signal;
  const start={x:2.5,y:64,z:2.5},target={x:9.5,y:64,z:2.5};
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined> =>
    x===0&&z===0?terrain:undefined;
  const lister=async()=>[{x:0,z:0}];

  let dynamic=[
    {x:5,y:64,z:2,stateId:OBSIDIAN},
    {x:5,y:65,z:2,stateId:OBSIDIAN}
  ];
  const dynamicLoader=async()=>dynamic;

  const blocked=await service.plan(
    'reset-instance',start,target,loader,signal,[],lister,undefined,dynamicLoader
  );
  assert.equal(blocked.dynamicBlocks,2);
  assert.ok(blocked.waypoints.some(point=>point.z!==2.5));

  service.invalidateOverlay('reset-instance');
  dynamic=[];
  const rescanned=await service.plan(
    'reset-instance',start,target,loader,signal,[],lister,undefined,dynamicLoader
  );
  assert.equal(rescanned.dynamicBlocks,0);
  assert.ok(rescanned.waypoints.every(point=>point.z===2.5));
});

test('different weekly terrains coexist as separate fingerprint generations', async () => {
  const service=new PitNavigationService();
  const castle=chunkWithWall(true);
  const coral=chunkWithWall(false);
  const signal=new AbortController().signal;
  const start={x:2.5,y:64,z:2.5},target={x:9.5,y:64,z:2.5};

  const a=await service.plan('castle-instance',start,target,async (x,z)=>x===0&&z===0?castle:undefined,signal);
  const b=await service.plan('coral-instance',start,target,async (x,z)=>x===0&&z===0?coral:undefined,signal);
  assert.notEqual(a.fingerprint,b.fingerprint);
  assert.equal(service.cache.snapshot(Date.now()).length,2);
});

test('same terrain fingerprint shares one cached graph across Pit instances', async () => {
  const service=new PitNavigationService();
  const terrain=chunkWithWall();
  const loader=async (x:number,z:number):Promise<PitChunkData|undefined> =>
    x===0&&z===0?terrain:undefined;
  const signal=new AbortController().signal;
  const start={x:2.5,y:64,z:2.5},target={x:9.5,y:64,z:2.5};

  const a=await service.plan('mega-a',start,target,loader,signal);
  const b=await service.plan('mega-b',start,target,loader,signal);
  assert.equal(a.fingerprint,b.fingerprint);
  const snapshots=service.cache.snapshot(Date.now());
  assert.equal(snapshots.length,1);
  assert.deepEqual(snapshots[0]?.instances,['mega-a','mega-b']);
});

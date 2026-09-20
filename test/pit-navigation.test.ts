import test from 'node:test';
import assert from 'node:assert/strict';
import { PitNavigationService, type PitChunkData } from '../src/pathfinding/pit-navigation.js';

const STONE=1;

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
    lister
  );
  assert.equal(first.complete,true);
  assert.equal(first.scannedChunks,3);
  assert.equal(listCalls,1);
  const afterFirst=loadCalls;

  const second=await service.plan(
    'mega-full',
    {x:3.5,y:64,z:2.5},
    {x:39.5,y:64,z:2.5},
    loader,
    signal,
    [],
    lister
  );
  assert.equal(second.complete,true);
  assert.equal(listCalls,1);
  assert.equal(loadCalls,afterFirst);
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

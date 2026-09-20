import test from 'node:test';
import assert from 'node:assert/strict';
import { PitNavigationService, type PitChunkData } from '../src/pathfinding/pit-navigation.js';

const STONE=1<<4;

function chunkWithWall():PitChunkData {
  const sections=new Map<number,Uint16Array>();
  const set=(x:number,y:number,z:number,state:number)=>{
    const sy=y>>4;
    let values=sections.get(sy);
    if(!values){values=new Uint16Array(4096);sections.set(sy,values);}
    values[((y&15)*256)+(z*16)+x]=state;
  };

  for(let x=0;x<16;x++)for(let z=0;z<16;z++)set(x,63,z,STONE);
  for(let z=0;z<=9;z++){
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

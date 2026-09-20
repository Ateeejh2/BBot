import { createHash } from 'node:crypto';
import type { Position } from '../core/types.js';
import { PitMapCache } from './map-cache.js';

export interface PitChunkSection {
  y: number;
  states: Uint16Array;
}
export interface PitChunkData {
  chunkX: number;
  chunkZ: number;
  sections: PitChunkSection[];
}
export interface PitDynamicBlock extends Position { stateId:number }

export type PitChunkLoader = (chunkX: number, chunkZ: number, signal: AbortSignal) => Promise<PitChunkData | undefined>;
export type PitLoadedChunkLister = (signal: AbortSignal) => Promise<Array<{x:number;z:number}>>;
export type PitDynamicChunkLoader = (chunkX:number,chunkZ:number,signal:AbortSignal)=>Promise<PitDynamicBlock[]>;
export type PitScanProgress = (done:number,total:number)=>void;

export interface PitNavigationPlan {
  fingerprint: string;
  previousFingerprint?: string;
  cacheStatus: 'HIT' | 'SHARED_HIT' | 'FULL_SCAN' | 'REVALIDATED';
  overlayRevision: number;
  dynamicBlocks: number;
  waypoints: Position[];
  complete: boolean;
  scannedChunks: number;
  expandedNodes: number;
}

interface NavNode { x:number; y:number; z:number }
interface TerrainGraph {
  fingerprint: string;
  chunks: Map<string, PitChunkData>;
  nodes: Map<string, NavNode>;
  columns: Map<string, Set<number>>;
}
interface DynamicOverlay {
  blocks: Map<string,number>;
  columns: Map<string,Set<number>>;
  revision: number;
}

const SAMPLE_OFFSETS = [[0,0],[-1,0],[1,0],[0,-1],[0,1]] as const;
const CARDINAL = [[1,0],[-1,0],[0,1],[0,-1]] as const;
const PASSABLE_BLOCK_IDS = new Set([
  0, 6, 31, 32, 37, 38, 39, 40, 50, 55, 59, 63, 65, 66, 68, 69, 70, 72,
  75, 76, 77, 78, 83, 106, 115, 131, 132, 141, 142, 143, 171, 175
]);
const HAZARDOUS_FLOOR_IDS = new Set([8,9,10,11,30,51,81]);

export class PitNavigationService {
  readonly cache: PitMapCache<TerrainGraph>;
  private readonly anchors = new Map<string,{x:number;z:number}>();
  private readonly instanceUsers = new Map<string,number>();
  private readonly overlays = new Map<string,DynamicOverlay>();
  private readonly overlayReady = new Set<string>();
  private readonly overlayLoads = new Map<string,Promise<void>>();
  private readonly overlayEpoch = new Map<string,number>();
  private readonly overlayChanges = new Map<string,Array<{revision:number;x:number;y:number;z:number}>>();

  constructor(refreshAfterMs = 7 * 24 * 60 * 60 * 1000, maxGenerations = 6) {
    this.cache = new PitMapCache<TerrainGraph>(refreshAfterMs, maxGenerations);
  }

  retainInstance(instanceId:string, position?:Position):void {
    const key=normalizeInstance(instanceId);
    this.instanceUsers.set(key,(this.instanceUsers.get(key)??0)+1);
    if(position&&!this.anchors.has(key)){
      this.anchors.set(key,{x:Math.floor(position.x/16),z:Math.floor(position.z/16)});
    }
  }

  releaseInstance(instanceId:string):void {
    const key=normalizeInstance(instanceId);
    const next=(this.instanceUsers.get(key)??0)-1;
    if(next>0){this.instanceUsers.set(key,next);return;}
    this.instanceUsers.delete(key);
    this.cache.unbind(instanceId);
    this.anchors.delete(key);
    // No bot is watching this instance anymore, so future block changes are
    // unknowable. Drop only the instance overlay; the shared base graph remains.
    this.overlays.delete(key);
    this.overlayReady.delete(key);
    this.overlayLoads.delete(key);
    this.overlayEpoch.delete(key);
    this.overlayChanges.delete(key);
  }

  invalidate(instanceId: string): void {
    this.cache.invalidateInstance(instanceId);
  }

  invalidateOverlay(instanceId:string):void {
    const key=normalizeInstance(instanceId);
    this.overlayReady.delete(key);
    this.overlays.delete(key);
    this.overlayChanges.delete(key);
    this.overlayEpoch.set(key,(this.overlayEpoch.get(key)??0)+1);
  }

  overlayRevision(instanceId:string):number {
    return this.overlays.get(normalizeInstance(instanceId))?.revision??0;
  }

  updateDynamicBlock(instanceId:string, position:Position, stateId:number):number|undefined {
    const key=normalizeInstance(instanceId);
    const overlay=this.overlay(key);
    const x=Math.floor(position.x),y=Math.floor(position.y),z=Math.floor(position.z);
    if(y<0||y>255)return;
    const positionId=positionKey(x,y,z);
    const changed=isVolatileState(stateId)
      ?setOverlayBlock(overlay,x,y,z,stateId)
      :overlay.blocks.has(positionId)&&deleteOverlayBlock(overlay,x,y,z);
    if(!changed)return;
    let journal=this.overlayChanges.get(key);
    if(!journal){journal=[];this.overlayChanges.set(key,journal);}
    journal.push({revision:overlay.revision,x,y,z});
    if(journal.length>256)journal.splice(0,journal.length-256);
    return overlay.revision;
  }

  dynamicChangesSince(instanceId:string, revision:number):Array<{revision:number;x:number;y:number;z:number}> {
    const journal=this.overlayChanges.get(normalizeInstance(instanceId));
    if(!journal)return [];
    return journal.filter(change=>change.revision>revision);
  }

  async plan(
    instanceId: string,
    start: Position,
    target: Position,
    loader: PitChunkLoader,
    signal: AbortSignal,
    avoidColumns: ReadonlyArray<Pick<Position,'x'|'z'>> = [],
    listLoadedChunks?: PitLoadedChunkLister,
    onScanProgress?: PitScanProgress,
    loadDynamicChunk?: PitDynamicChunkLoader
  ): Promise<PitNavigationPlan> {
    signal.throwIfAborted();
    const prepared = await this.ensureGraph(instanceId, start, loader, signal, listLoadedChunks, onScanProgress);
    await this.ensureOverlay(instanceId,signal,listLoadedChunks,loadDynamicChunk,onScanProgress);
    const graph=prepared.graph;
    const overlay=this.overlay(normalizeInstance(instanceId));

    const startNode = nearestNode(graph,overlay,start,4,5);
    if (!startNode) throw new Error('No path to the goal!');

    const goalNode = nearestNode(graph,overlay,target,3,5);
    const avoided=new Set(avoidColumns.map(value=>columnKey(Math.floor(value.x),Math.floor(value.z))));
    const search = searchGraph(graph,overlay,startNode,target,goalNode,50_000,avoided);
    if (search.path.length < 2) {
      const horizontal = Math.hypot(target.x - start.x, target.z - start.z);
      if (horizontal > 1.25) throw new Error('No path to the goal!');
    }

    return {
      fingerprint: graph.fingerprint,
      previousFingerprint: prepared.previousFingerprint,
      cacheStatus: prepared.cacheStatus,
      overlayRevision: overlay.revision,
      dynamicBlocks: overlay.blocks.size,
      waypoints: compressPath(search.path),
      complete: search.complete,
      scannedChunks: graph.chunks.size,
      expandedNodes: search.expanded
    };
  }

  private overlay(instanceKey:string):DynamicOverlay {
    let overlay=this.overlays.get(instanceKey);
    if(!overlay){
      overlay={blocks:new Map(),columns:new Map(),revision:0};
      this.overlays.set(instanceKey,overlay);
    }
    return overlay;
  }

  private async ensureOverlay(
    instanceId:string,
    signal:AbortSignal,
    listLoadedChunks?:PitLoadedChunkLister,
    loadDynamicChunk?:PitDynamicChunkLoader,
    onScanProgress?:PitScanProgress
  ):Promise<void>{
    const key=normalizeInstance(instanceId);
    if(this.overlayReady.has(key))return;
    const pending=this.overlayLoads.get(key);
    if(pending){await pending;return;}
    if(!listLoadedChunks||!loadDynamicChunk){
      this.overlayReady.add(key);
      return;
    }

    const epoch=this.overlayEpoch.get(key)??0;
    const task=(async()=>{
      const coords=await listLoadedChunks(signal);
      const unique=new Map<string,{x:number;z:number}>();
      for(const value of coords)unique.set(chunkKey(value.x,value.z),value);
      const queue=[...unique.values()];
      const overlay=this.overlay(key);
      overlay.blocks.clear();overlay.columns.clear();overlay.revision++;
      this.overlayChanges.delete(key);
      let done=0;
      onScanProgress?.(0,queue.length);
      for(let i=0;i<queue.length;i+=2){
        signal.throwIfAborted();
        const batch=queue.slice(i,i+2);
        const results=await Promise.all(batch.map(async ({x,z})=>{
          try{return await loadDynamicChunk(x,z,signal);}
          catch(error){if(signal.aborted)throw error;return [];}
        }));
        for(const blocks of results)for(const block of blocks){
          if(isVolatileState(block.stateId))setOverlayBlock(overlay,Math.floor(block.x),Math.floor(block.y),Math.floor(block.z),block.stateId,false);
        }
        done+=batch.length;
        onScanProgress?.(done,queue.length);
      }
      if(queue.length===0)onScanProgress?.(0,0);
      overlay.revision++;
      if((this.overlayEpoch.get(key)??0)===epoch)this.overlayReady.add(key);
    })().finally(()=>this.overlayLoads.delete(key));
    this.overlayLoads.set(key,task);
    await task;
  }

  private async ensureGraph(
    instanceId: string,
    start: Position,
    loader: PitChunkLoader,
    signal: AbortSignal,
    listLoadedChunks?: PitLoadedChunkLister,
    onScanProgress?: PitScanProgress
  ): Promise<{graph:TerrainGraph;cacheStatus:PitNavigationPlan['cacheStatus'];previousFingerprint?:string}> {
    const now = Date.now();
    const instanceKey=normalizeInstance(instanceId);
    const existingFingerprint = this.cache.fingerprintForInstance(instanceId);
    const existingGraph = this.cache.graphForInstance(instanceId);
    if (existingFingerprint && existingGraph && !this.cache.refreshDue(instanceId, now)) {
      return {graph:existingGraph,cacheStatus:'HIT',previousFingerprint:existingFingerprint};
    }

    let anchor=this.anchors.get(instanceKey);
    if(!anchor){
      anchor={x:Math.floor(start.x/16),z:Math.floor(start.z/16)};
      this.anchors.set(instanceKey,anchor);
    }
    const samples: Array<{dx:number;dz:number;chunk:PitChunkData}> = [];
    for (const [dx,dz] of SAMPLE_OFFSETS) {
      signal.throwIfAborted();
      const chunk = await loader(anchor.x + dx, anchor.z + dz, signal);
      if (chunk) samples.push({ dx, dz, chunk });
    }
    if (!samples.length) {
      if (existingGraph) return {graph:existingGraph,cacheStatus:'HIT',previousFingerprint:existingFingerprint};
      throw new Error('No path to the goal!');
    }

    const fingerprint = terrainFingerprint(samples);
    if(existingFingerprint&&existingFingerprint!==fingerprint)this.invalidateOverlay(instanceId);
    this.cache.bind(instanceId, fingerprint, now);
    let graph = this.cache.graphForInstance(instanceId);
    if (!graph) {
      graph = { fingerprint, chunks:new Map(), nodes:new Map(), columns:new Map() };
      const loadedCoords = listLoadedChunks ? await listLoadedChunks(signal) : [];
      const unique = new Map<string,{x:number;z:number}>();
      for (const value of loadedCoords) unique.set(chunkKey(value.x,value.z),value);
      for (const sample of samples) unique.set(chunkKey(sample.chunk.chunkX,sample.chunk.chunkZ),{
        x:sample.chunk.chunkX,z:sample.chunk.chunkZ
      });

      const queue=[...unique.values()];
      const overlay=this.overlay(instanceKey);
      overlay.blocks.clear();overlay.columns.clear();overlay.revision++;
      this.overlayChanges.delete(instanceKey);
      let done=0;
      onScanProgress?.(0,queue.length);
      for(let i=0;i<queue.length;i+=2){
        signal.throwIfAborted();
        const batch=queue.slice(i,i+2);
        const loaded=await Promise.all(batch.map(async ({x,z})=>{
          const sample=samples.find(value=>value.chunk.chunkX===x&&value.chunk.chunkZ===z)?.chunk;
          if(sample)return sample;
          try{return await loader(x,z,signal);}
          catch(error){if(signal.aborted)throw error;return undefined;}
        }));
        for(const chunk of loaded)if(chunk){
          collectDynamicBlocks(overlay,chunk);
          addChunk(graph,chunk);
        }
        done+=batch.length;
        onScanProgress?.(done,queue.length);
      }
      if(queue.length===0)onScanProgress?.(0,0);
      overlay.revision++;
      this.overlayReady.add(instanceKey);
      this.cache.setGraph(fingerprint, graph, now);
      return {graph,cacheStatus:'FULL_SCAN',previousFingerprint:existingFingerprint};
    }
    if (this.cache.refreshDue(instanceId, now)) {
      this.cache.setGraph(fingerprint, graph, now);
      return {graph,cacheStatus:'REVALIDATED',previousFingerprint:existingFingerprint};
    }
    return {graph,cacheStatus:'SHARED_HIT',previousFingerprint:existingFingerprint};
  }

}

function terrainFingerprint(samples:Array<{dx:number;dz:number;chunk:PitChunkData}>):string {
  const hash=createHash('sha256');
  const ordered=[...samples].sort((a,b)=>a.dx-b.dx||a.dz-b.dz);
  for (const sample of ordered) {
    hash.update(`${sample.dx},${sample.dz}|`);
    const sections=[...sample.chunk.sections].sort((a,b)=>a.y-b.y);
    for (const section of sections) {
      hash.update(String(section.y));
      const normalized=Buffer.allocUnsafe(section.states.length*2);
      for (let i=0;i<section.states.length;i++) normalized.writeUInt16LE(baseState(section.states[i]??0),i*2);
      hash.update(normalized);
    }
  }
  return `terrain:${hash.digest('hex').slice(0,24)}`;
}

function addChunk(graph:TerrainGraph,chunk:PitChunkData):void {
  const key=chunkKey(chunk.chunkX,chunk.chunkZ);
  if(graph.chunks.has(key))return;
  graph.chunks.set(key,chunk);
  const sectionMap=new Map(chunk.sections.map(section=>[section.y,section.states] as const));
  const sectionYs=[...sectionMap.keys()];
  if(!sectionYs.length)return;
  const minY=Math.max(1,Math.min(...sectionYs)*16);
  const maxY=Math.min(254,Math.max(...sectionYs)*16+18);
  const minX=chunk.chunkX*16,minZ=chunk.chunkZ*16;
  const state=(lx:number,y:number,lz:number):number=>{
    if(y<0||y>255)return 0;
    const section=sectionMap.get(y>>4);
    if(!section)return 0;
    return baseState(section[((y&15)*256)+(lz*16)+lx]??0);
  };
  for(let lx=0;lx<16;lx++)for(let lz=0;lz<16;lz++){
    for(let y=minY;y<=maxY;y++){
      const feet=state(lx,y,lz),head=state(lx,y+1,lz),floor=state(lx,y-1,lz);
      if(!isPassable(feet)||!isPassable(head))continue;
      const floorId=blockId(floor);
      if(floor===0||isPassable(floor)||HAZARDOUS_FLOOR_IDS.has(floorId))continue;
      const node={x:minX+lx,y,z:minZ+lz};
      graph.nodes.set(nodeKey(node.x,node.y,node.z),node);
      const cKey=columnKey(node.x,node.z);
      let ys=graph.columns.get(cKey);
      if(!ys){ys=new Set<number>();graph.columns.set(cKey,ys);}
      ys.add(node.y);
    }
  }
}

function collectDynamicBlocks(overlay:DynamicOverlay,chunk:PitChunkData):void {
  for(const section of chunk.sections){
    for(let i=0;i<section.states.length;i++){
      const state=section.states[i]??0;
      if(!isVolatileState(state))continue;
      const y=section.y*16+Math.floor(i/256);
      const rem=i%256;
      const z=Math.floor(rem/16),x=rem%16;
      setOverlayBlock(overlay,chunk.chunkX*16+x,y,chunk.chunkZ*16+z,state,false);
    }
  }
}

function setOverlayBlock(overlay:DynamicOverlay,x:number,y:number,z:number,stateId:number,bump=true):boolean {
  const key=positionKey(x,y,z);
  const previous=overlay.blocks.get(key);
  if(previous===stateId)return false;
  overlay.blocks.set(key,stateId);
  const cKey=columnKey(x,z);
  let ys=overlay.columns.get(cKey);
  if(!ys){ys=new Set<number>();overlay.columns.set(cKey,ys);}
  ys.add(y);
  if(bump)overlay.revision++;
  return true;
}

function deleteOverlayBlock(overlay:DynamicOverlay,x:number,y:number,z:number,bump=true):boolean {
  const key=positionKey(x,y,z);
  if(!overlay.blocks.delete(key))return false;
  const cKey=columnKey(x,z),ys=overlay.columns.get(cKey);
  ys?.delete(y);
  if(ys?.size===0)overlay.columns.delete(cKey);
  if(bump)overlay.revision++;
  return true;
}

function baseState(state:number):number {
  const id=blockId(state);
  return id===54||isVolatileState(state)?0:state;
}

function isVolatileState(state:number):boolean {
  const id=blockId(state),metadata=state>>>12&0x0f;
  return id===49||id===4||id===7||(id===5&&metadata===0);
}

function blockId(state:number):number {
  return state & 0x0fff;
}

function isPassable(state:number):boolean {
  return PASSABLE_BLOCK_IDS.has(blockId(state));
}

function baseStateAt(graph:TerrainGraph,x:number,y:number,z:number):number {
  if(y<0||y>255)return 0;
  const chunk=graph.chunks.get(chunkKey(Math.floor(x/16),Math.floor(z/16)));
  if(!chunk)return 0;
  const section=chunk.sections.find(value=>value.y===(y>>4));
  if(!section)return 0;
  return baseState(section.states[((y&15)*256)+((z&15)*16)+(x&15)]??0);
}

function effectiveState(graph:TerrainGraph,overlay:DynamicOverlay,x:number,y:number,z:number):number {
  return overlay.blocks.get(positionKey(x,y,z))??baseStateAt(graph,x,y,z);
}

function effectiveStandable(graph:TerrainGraph,overlay:DynamicOverlay,x:number,y:number,z:number):boolean {
  const feet=effectiveState(graph,overlay,x,y,z);
  const head=effectiveState(graph,overlay,x,y+1,z);
  const floor=effectiveState(graph,overlay,x,y-1,z);
  return isPassable(feet)&&isPassable(head)&&floor!==0&&!isPassable(floor)&&!HAZARDOUS_FLOOR_IDS.has(blockId(floor));
}

function candidateYs(graph:TerrainGraph,overlay:DynamicOverlay,x:number,z:number):Set<number> {
  const result=new Set(graph.columns.get(columnKey(x,z))??[]);
  for(const y of overlay.columns.get(columnKey(x,z))??[])result.add(y+1);
  return result;
}

function nearestNode(graph:TerrainGraph,overlay:DynamicOverlay,target:Position,radius:number,vertical:number):NavNode|undefined {
  let best:NavNode|undefined,bestScore=Number.POSITIVE_INFINITY;
  const baseX=Math.floor(target.x),baseZ=Math.floor(target.z);
  for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++){
    const x=baseX+dx,z=baseZ+dz;
    for(const y of candidateYs(graph,overlay,x,z)){
      if(Math.abs(y-target.y)>vertical||!effectiveStandable(graph,overlay,x,y,z))continue;
      const score=Math.hypot(x+0.5-target.x,z+0.5-target.z)+Math.abs(y-target.y)*0.35;
      if(score<bestScore){bestScore=score;best={x,y,z};}
    }
  }
  return best;
}

function searchGraph(
  graph:TerrainGraph,
  overlay:DynamicOverlay,
  start:NavNode,
  target:Position,
  goal:NavNode|undefined,
  maxExpanded:number,
  avoided:Set<string>
):{path:NavNode[];complete:boolean;expanded:number}{
  const startKey=nodeKey(start.x,start.y,start.z);
  const goalKey=goal?nodeKey(goal.x,goal.y,goal.z):undefined;
  const open=new MinHeap();
  const g=new Map<string,number>([[startKey,0]]);
  const parent=new Map<string,string>();
  const closed=new Set<string>();
  open.push(startKey,heuristic(start,target));
  let bestKey=startKey,bestH=heuristic(start,target),expanded=0;

  while(open.size&&expanded<maxExpanded){
    const currentKey=open.pop()!;
    if(closed.has(currentKey))continue;
    const current=parseNodeKey(currentKey);
    if(!current||!effectiveStandable(graph,overlay,current.x,current.y,current.z))continue;
    closed.add(currentKey);expanded++;
    const h=heuristic(current,target);
    if(h<bestH){bestH=h;bestKey=currentKey;}
    if(goalKey&&currentKey===goalKey)return {path:reconstruct(parent,currentKey),complete:true,expanded};

    const currentG=g.get(currentKey)??Number.POSITIVE_INFINITY;
    for(const next of neighbors(graph,overlay,current,avoided)){
      const key=nodeKey(next.x,next.y,next.z);
      if(closed.has(key))continue;
      const vertical=next.y-current.y;
      const verticalCost=vertical>0?vertical*0.35+0.2:Math.min(1.5,Math.abs(vertical)*0.03);
      const tentative=currentG+1+verticalCost;
      if(tentative>=(g.get(key)??Number.POSITIVE_INFINITY))continue;
      g.set(key,tentative);parent.set(key,currentKey);
      open.push(key,tentative+heuristic(next,target));
    }
  }

  return {path:reconstruct(parent,bestKey),complete:false,expanded};
}

function neighbors(graph:TerrainGraph,overlay:DynamicOverlay,node:NavNode,avoided:Set<string>):NavNode[]{
  const result:NavNode[]=[];
  for(const [dx,dz] of CARDINAL){
    const x=node.x+dx,z=node.z+dz,cKey=columnKey(x,z);
    if(avoided.has(cKey))continue;
    const valid=[...candidateYs(graph,overlay,x,z)]
      .filter(y=>effectiveStandable(graph,overlay,x,y,z))
      .sort((a,b)=>b-a);
    let nextY:number|undefined;
    if(valid.includes(node.y))nextY=node.y;
    else if(valid.includes(node.y+1))nextY=node.y+1;
    else nextY=valid.find(y=>y<node.y);
    if(nextY!==undefined)result.push({x,y:nextY,z});
  }
  return result;
}

function reconstruct(parent:Map<string,string>,endKey:string):NavNode[]{
  const keys=[endKey];let cursor=endKey;
  while(parent.has(cursor)){cursor=parent.get(cursor)!;keys.push(cursor);}
  keys.reverse();
  return keys.flatMap(key=>{const node=parseNodeKey(key);return node?[node]:[];});
}

function parseNodeKey(key:string):NavNode|undefined {
  const parts=key.split(',').map(Number);
  if(parts.length!==3||parts.some(value=>!Number.isFinite(value)))return;
  return {x:parts[0]!,y:parts[1]!,z:parts[2]!};
}

function compressPath(path:NavNode[]):Position[]{
  if(path.length<=1)return [];
  const out:NavNode[]=[];
  let anchor=path[0]!,previous=path[0]!;
  let dirX=0,dirZ=0;
  for(let i=1;i<path.length;i++){
    const current=path[i]!;
    const nextDirX=Math.sign(current.x-previous.x),nextDirZ=Math.sign(current.z-previous.z);
    const sameDirection=i===1||(nextDirX===dirX&&nextDirZ===dirZ&&current.y===previous.y&&previous.y===anchor.y);
    if(!sameDirection){out.push(previous);anchor=previous;}
    dirX=nextDirX;dirZ=nextDirZ;previous=current;
  }
  out.push(path[path.length-1]!);
  return out.map(node=>({x:node.x+0.5,y:node.y,z:node.z+0.5}));
}

function heuristic(node:NavNode,target:Position):number {
  return Math.abs(node.x+0.5-target.x)+Math.abs(node.z+0.5-target.z)+Math.abs(node.y-target.y)*0.25;
}

function normalizeInstance(value:string):string{return value.toLowerCase();}
function chunkKey(x:number,z:number):string{return `${x},${z}`;}
function columnKey(x:number,z:number):string{return `${x},${z}`;}
function positionKey(x:number,y:number,z:number):string{return `${x},${y},${z}`;}
function nodeKey(x:number,y:number,z:number):string{return `${x},${y},${z}`;}

class MinHeap {
  private values:Array<{key:string;score:number}>=[];
  get size():number{return this.values.length;}
  push(key:string,score:number):void{
    const item={key,score};this.values.push(item);let i=this.values.length-1;
    while(i>0){const p=(i-1)>>1;if(this.values[p]!.score<=score)break;this.values[i]=this.values[p]!;i=p;}
    this.values[i]=item;
  }
  pop():string|undefined{
    if(!this.values.length)return;
    const root=this.values[0]!,last=this.values.pop()!;
    if(this.values.length){
      let i=0;
      while(true){
        const l=i*2+1,r=l+1;if(l>=this.values.length)break;
        const child=r<this.values.length&&this.values[r]!.score<this.values[l]!.score?r:l;
        if(this.values[child]!.score>=last.score)break;
        this.values[i]=this.values[child]!;i=child;
      }
      this.values[i]=last;
    }
    return root.key;
  }
}

export const sharedPitNavigation = new PitNavigationService();

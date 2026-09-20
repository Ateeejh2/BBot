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
export type PitChunkLoader = (chunkX: number, chunkZ: number, signal: AbortSignal) => Promise<PitChunkData | undefined>;

export interface PitNavigationPlan {
  fingerprint: string;
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

const SAMPLE_OFFSETS = [[0,0],[-1,0],[1,0],[0,-1],[0,1]] as const;
const CARDINAL = [[1,0],[-1,0],[0,1],[0,-1]] as const;
const PASSABLE_BLOCK_IDS = new Set([
  0, 6, 31, 32, 37, 38, 39, 40, 50, 55, 59, 63, 65, 66, 68, 69, 70, 72,
  75, 76, 77, 78, 83, 106, 115, 131, 132, 141, 142, 143, 171, 175
]);
const HAZARDOUS_FLOOR_IDS = new Set([8,9,10,11,30,51,81]);

export class PitNavigationService {
  readonly cache: PitMapCache<TerrainGraph>;

  constructor(refreshAfterMs = 7 * 24 * 60 * 60 * 1000, maxGenerations = 6) {
    this.cache = new PitMapCache<TerrainGraph>(refreshAfterMs, maxGenerations);
  }

  bindHint(instanceId: string): void {
    // Instance binding is established lazily after a terrain fingerprint is observed.
    // This method exists so transports can make the intended lifecycle explicit.
    void instanceId;
  }

  unbind(instanceId: string): void {
    this.cache.unbind(instanceId);
  }

  invalidate(instanceId: string): void {
    this.cache.invalidateInstance(instanceId);
  }

  async plan(
    instanceId: string,
    start: Position,
    target: Position,
    loader: PitChunkLoader,
    signal: AbortSignal,
    avoidColumns: ReadonlyArray<Pick<Position,'x'|'z'>> = []
  ): Promise<PitNavigationPlan> {
    signal.throwIfAborted();
    const graph = await this.ensureGraph(instanceId, start, loader, signal);
    await this.loadLocalWindow(graph, start, loader, signal);

    const startNode = nearestNode(graph, start, 4, 5);
    if (!startNode) throw new Error('No path to the goal!');

    const goalNode = nearestNode(graph, target, 3, 5);
    const avoided=new Set(avoidColumns.map(value=>columnKey(Math.floor(value.x),Math.floor(value.z))));
    const search = searchGraph(graph, startNode, target, goalNode, 50_000, avoided);
    if (search.path.length < 2) {
      const horizontal = Math.hypot(target.x - start.x, target.z - start.z);
      if (horizontal > 1.25) throw new Error('No path to the goal!');
    }

    return {
      fingerprint: graph.fingerprint,
      waypoints: compressPath(search.path),
      complete: search.complete,
      scannedChunks: graph.chunks.size,
      expandedNodes: search.expanded
    };
  }

  private async ensureGraph(instanceId: string, start: Position, loader: PitChunkLoader, signal: AbortSignal): Promise<TerrainGraph> {
    const now = Date.now();
    const existingFingerprint = this.cache.fingerprintForInstance(instanceId);
    const existingGraph = this.cache.graphForInstance(instanceId);
    if (existingFingerprint && existingGraph && !this.cache.refreshDue(instanceId, now)) return existingGraph;

    const centerX = Math.floor(start.x / 16);
    const centerZ = Math.floor(start.z / 16);
    const samples: Array<{dx:number;dz:number;chunk:PitChunkData}> = [];
    for (const [dx,dz] of SAMPLE_OFFSETS) {
      signal.throwIfAborted();
      const chunk = await loader(centerX + dx, centerZ + dz, signal);
      if (chunk) samples.push({ dx, dz, chunk });
    }
    if (!samples.length) {
      if (existingGraph) return existingGraph;
      throw new Error('No path to the goal!');
    }

    const fingerprint = terrainFingerprint(samples);
    this.cache.bind(instanceId, fingerprint, now);
    let graph = this.cache.graphForInstance(instanceId);
    if (!graph) {
      graph = { fingerprint, chunks:new Map(), nodes:new Map(), columns:new Map() };
      this.cache.setGraph(fingerprint, graph, now);
    } else if (this.cache.refreshDue(instanceId, now)) {
      // A fresh sample produced the same fingerprint, so the cached generation is
      // still valid. Refresh its validation timestamp without rebuilding it.
      this.cache.setGraph(fingerprint, graph, now);
    }
    for (const sample of samples) addChunk(graph, sample.chunk);
    return graph;
  }

  private async loadLocalWindow(graph: TerrainGraph, start: Position, loader: PitChunkLoader, signal: AbortSignal): Promise<void> {
    const centerX=Math.floor(start.x/16),centerZ=Math.floor(start.z/16);
    const queue:Array<{x:number;z:number}>=[];
    for(let radius=0;radius<=2;radius++){
      for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++){
        if(Math.max(Math.abs(dx),Math.abs(dz))!==radius)continue;
        const x=centerX+dx,z=centerZ+dz;
        if(!graph.chunks.has(chunkKey(x,z)))queue.push({x,z});
      }
    }

    // Keep Minecraft's client tick responsive: getChunk scans are intentionally
    // limited to the currently loaded neighborhood and issued only two at a time.
    for(let i=0;i<queue.length;i+=2){
      signal.throwIfAborted();
      const loaded=await Promise.all(queue.slice(i,i+2).map(async ({x,z})=>{
        try{return await loader(x,z,signal);}
        catch(error){if(signal.aborted)throw error;return undefined;}
      }));
      for(const chunk of loaded)if(chunk)addChunk(graph,chunk);
    }
  }
}}

function terrainFingerprint(samples:Array<{dx:number;dz:number;chunk:PitChunkData}>):string {
  const hash=createHash('sha256');
  const ordered=[...samples].sort((a,b)=>a.dx-b.dx||a.dz-b.dz);
  for (const sample of ordered) {
    hash.update(`${sample.dx},${sample.dz}|`);
    const sections=[...sample.chunk.sections].sort((a,b)=>a.y-b.y);
    for (const section of sections) {
      hash.update(String(section.y));
      const normalized=Buffer.allocUnsafe(section.states.length*2);
      for (let i=0;i<section.states.length;i++) {
        const state=section.states[i]??0;
        const id=blockId(state);
        // Care Package chests are dynamic and must not create a new map generation.
        const stable=id===54?0:state;
        normalized.writeUInt16LE(stable,i*2);
      }
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
    return section[((y&15)*256)+(lz*16)+lx]??0;
  };
  for(let lx=0;lx<16;lx++)for(let lz=0;lz<16;lz++){
    for(let y=minY;y<=maxY;y++){
      const feet=state(lx,y,lz),head=state(lx,y+1,lz),floor=state(lx,y-1,lz);
      if(!isPassable(feet)||!isPassable(head))continue;
      const floorId=blockId(floor);
      if(floor===0||isPassable(floor)||HAZARDOUS_FLOOR_IDS.has(floorId))continue;
      const node={x:minX+lx,y,z:minZ+lz};
      const nKey=nodeKey(node.x,node.y,node.z);
      graph.nodes.set(nKey,node);
      const cKey=columnKey(node.x,node.z);
      let ys=graph.columns.get(cKey);
      if(!ys){ys=new Set<number>();graph.columns.set(cKey,ys);}
      ys.add(node.y);
    }
  }
}

function blockId(state:number):number {
  // Minecraft 1.8.9 Block.getStateId stores block id in the low 12 bits
  // and metadata in the high 4 bits.
  return state & 0x0fff;
}

function isPassable(state:number):boolean {
  return PASSABLE_BLOCK_IDS.has(blockId(state));
}

function nearestNode(graph:TerrainGraph,target:Position,radius:number,vertical:number):NavNode|undefined {
  let best:NavNode|undefined,bestScore=Number.POSITIVE_INFINITY;
  const baseX=Math.floor(target.x),baseZ=Math.floor(target.z);
  for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++){
    const ys=graph.columns.get(columnKey(baseX+dx,baseZ+dz));
    if(!ys)continue;
    for(const y of ys){
      if(Math.abs(y-target.y)>vertical)continue;
      const score=Math.hypot(baseX+dx+0.5-target.x,baseZ+dz+0.5-target.z)+Math.abs(y-target.y)*0.35;
      if(score<bestScore){bestScore=score;best=graph.nodes.get(nodeKey(baseX+dx,y,baseZ+dz));}
    }
  }
  return best;
}

function searchGraph(
  graph:TerrainGraph,
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
    const current=graph.nodes.get(currentKey);
    if(!current)continue;
    closed.add(currentKey);expanded++;
    const h=heuristic(current,target);
    if(h<bestH){bestH=h;bestKey=currentKey;}
    if(goalKey&&currentKey===goalKey)return {path:reconstruct(graph,parent,currentKey),complete:true,expanded};

    const currentG=g.get(currentKey)??Number.POSITIVE_INFINITY;
    for(const next of neighbors(graph,current,avoided)){
      const key=nodeKey(next.x,next.y,next.z);
      if(closed.has(key))continue;
      const vertical=next.y-current.y;
      const tentative=currentG+1+Math.abs(vertical)*0.35+(vertical>0?0.2:0);
      if(tentative>=(g.get(key)??Number.POSITIVE_INFINITY))continue;
      g.set(key,tentative);parent.set(key,currentKey);
      open.push(key,tentative+heuristic(next,target));
    }
  }

  return {path:reconstruct(graph,parent,bestKey),complete:false,expanded};
}

function neighbors(graph:TerrainGraph,node:NavNode,avoided:Set<string>):NavNode[]{
  const result:NavNode[]=[];
  for(const [dx,dz] of CARDINAL){
    const x=node.x+dx,z=node.z+dz,cKey=columnKey(x,z);
    if(avoided.has(cKey))continue;
    const ys=graph.columns.get(cKey);
    if(!ys)continue;
    const candidates=[node.y,node.y+1,node.y-1,node.y-2,node.y-3];
    for(const y of candidates){
      if(!ys.has(y))continue;
      const next=graph.nodes.get(nodeKey(x,y,z));
      if(next)result.push(next);
      break;
    }
  }
  return result;
}

function reconstruct(graph:TerrainGraph,parent:Map<string,string>,endKey:string):NavNode[]{
  const keys=[endKey];let cursor=endKey;
  while(parent.has(cursor)){cursor=parent.get(cursor)!;keys.push(cursor);}
  keys.reverse();
  return keys.flatMap(key=>{const node=graph.nodes.get(key);return node?[node]:[];});
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

function chunkKey(x:number,z:number):string{return `${x},${z}`;}
function columnKey(x:number,z:number):string{return `${x},${z}`;}
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

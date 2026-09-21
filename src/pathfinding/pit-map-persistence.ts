import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PIT_MAP_DISK_FORMAT_VERSION=1;

export interface PitDiskChunkSection {
  y:number;
  states:string;
}

export interface PitDiskChunk {
  chunkX:number;
  chunkZ:number;
  sections:PitDiskChunkSection[];
}

export interface PitDiskGraph {
  formatVersion:typeof PIT_MAP_DISK_FORMAT_VERSION;
  fingerprint:string;
  savedAt:number;
  chunks:PitDiskChunk[];
  nodes:Array<[number,number,number]>;
}

const MAX_FILE_BYTES=128*1024*1024;
const MAX_CHUNKS=5000;
const MAX_NODES=2_000_000;

export class PitMapDiskStore {
  constructor(
    readonly directory:string,
    private readonly maxGenerations=6
  ){
    if(!directory)throw new Error('Invalid Pit map cache directory');
    if(!Number.isSafeInteger(maxGenerations)||maxGenerations<2)throw new Error('Invalid Pit map disk generation limit');
  }

  async load(fingerprint:string):Promise<PitDiskGraph|undefined>{
    const file=this.fileFor(fingerprint);
    try{
      const info=await stat(file);
      if(!info.isFile()||info.size<=0||info.size>MAX_FILE_BYTES)throw new Error('INVALID_PIT_MAP_CACHE');
      const raw:unknown=JSON.parse(await readFile(file,'utf8'));
      return validateGraph(raw,fingerprint);
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return;
      await rm(file,{force:true}).catch(()=>{});
      return;
    }
  }

  async save(graph:PitDiskGraph):Promise<void>{
    const validated=validateGraph(graph,graph.fingerprint);
    const file=this.fileFor(validated.fingerprint);
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const temp=`${file}.${randomUUID()}.tmp`;
    try{
      await writeFile(temp,JSON.stringify(validated),{encoding:'utf8',mode:0o600,flag:'wx'});
      await rename(temp,file);
      await this.prune();
    }catch(error){
      await rm(temp,{force:true}).catch(()=>{});
      throw error;
    }
  }

  private fileFor(fingerprint:string):string{
    const name=createHash('sha256').update(fingerprint).digest('hex').slice(0,40);
    return join(this.directory,`${name}.json`);
  }

  private async prune():Promise<void>{
    let names:string[];
    try{names=(await readdir(this.directory)).filter(name=>/^[0-9a-f]{40}\.json$/.test(name));}
    catch{return;}
    if(names.length<=this.maxGenerations)return;
    const files=await Promise.all(names.map(async name=>{
      const file=join(this.directory,name);
      try{return {file,mtime:(await stat(file)).mtimeMs};}
      catch{return undefined;}
    }));
    const ordered=files.filter((value):value is {file:string;mtime:number}=>Boolean(value))
      .sort((a,b)=>b.mtime-a.mtime);
    for(const entry of ordered.slice(this.maxGenerations))await rm(entry.file,{force:true}).catch(()=>{});
  }
}

function validateGraph(raw:unknown,expectedFingerprint:string):PitDiskGraph{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('INVALID_PIT_MAP_CACHE');
  const value=raw as Record<string,unknown>;
  if(value.formatVersion!==PIT_MAP_DISK_FORMAT_VERSION||
     typeof value.fingerprint!=='string'||value.fingerprint!==expectedFingerprint||
     !Number.isSafeInteger(value.savedAt)||(value.savedAt as number)<0||
     !Array.isArray(value.chunks)||value.chunks.length>MAX_CHUNKS||
     !Array.isArray(value.nodes)||value.nodes.length>MAX_NODES)throw new Error('INVALID_PIT_MAP_CACHE');

  const chunks:PitDiskChunk[]=[];
  for(const rawChunk of value.chunks){
    if(!rawChunk||typeof rawChunk!=='object'||Array.isArray(rawChunk))throw new Error('INVALID_PIT_MAP_CACHE');
    const chunk=rawChunk as Record<string,unknown>;
    if(!Number.isSafeInteger(chunk.chunkX)||!Number.isSafeInteger(chunk.chunkZ)||
       !Array.isArray(chunk.sections)||chunk.sections.length>16)throw new Error('INVALID_PIT_MAP_CACHE');
    const sections:PitDiskChunkSection[]=[];
    const seen=new Set<number>();
    for(const rawSection of chunk.sections){
      if(!rawSection||typeof rawSection!=='object'||Array.isArray(rawSection))throw new Error('INVALID_PIT_MAP_CACHE');
      const section=rawSection as Record<string,unknown>;
      if(!Number.isSafeInteger(section.y)||(section.y as number)<0||(section.y as number)>15||
         seen.has(section.y as number)||typeof section.states!=='string'||
         section.states.length>12_000)throw new Error('INVALID_PIT_MAP_CACHE');
      const bytes=Buffer.from(section.states,'base64');
      if(bytes.length!==8192)throw new Error('INVALID_PIT_MAP_CACHE');
      seen.add(section.y as number);
      sections.push({y:section.y as number,states:section.states});
    }
    chunks.push({chunkX:chunk.chunkX as number,chunkZ:chunk.chunkZ as number,sections});
  }

  const nodes:Array<[number,number,number]>=[];
  for(const rawNode of value.nodes){
    if(!Array.isArray(rawNode)||rawNode.length!==3||
       !rawNode.every(Number.isSafeInteger))throw new Error('INVALID_PIT_MAP_CACHE');
    const [x,y,z]=rawNode as [number,number,number];
    if(y<0||y>255)throw new Error('INVALID_PIT_MAP_CACHE');
    nodes.push([x,y,z]);
  }

  return {
    formatVersion:PIT_MAP_DISK_FORMAT_VERSION,
    fingerprint:value.fingerprint,
    savedAt:value.savedAt as number,
    chunks,
    nodes
  };
}

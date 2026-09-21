import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args=process.argv.slice(2);
const directory=resolve(args[0]??'data/pit-map-cache');

function decodeChunk(raw){
  const map=new Map();
  for(const chunk of raw.chunks??[]){
    for(const section of chunk.sections??[]){
      const bytes=Buffer.from(section.states,'base64');
      if(bytes.length!==8192)continue;
      for(let i=0;i<4096;i++){
        const state=bytes.readUInt16LE(i*2);
        if(state===0)continue;
        const y=section.y*16+Math.floor(i/256);
        const rem=i%256;
        const z=chunk.chunkZ*16+Math.floor(rem/16);
        const x=chunk.chunkX*16+(rem%16);
        map.set(`${x},${y},${z}`,state);
      }
    }
  }
  return map;
}

function blockId(state){return state&0x0fff;}
function metadata(state){return (state>>>12)&0x0f;}

const names=(await readdir(directory))
  .filter(name=>/^[0-9a-f]{40}\.json$/.test(name));

const files=await Promise.all(names.map(async name=>{
  const path=join(directory,name);
  return {path,name,mtime:(await stat(path)).mtimeMs};
}));
files.sort((a,b)=>b.mtime-a.mtime);

let selected;
if(args.length>=3){
  selected=[{path:resolve(args[1]),name:args[1]},{path:resolve(args[2]),name:args[2]}];
}else{
  selected=files.slice(0,2);
}
if(selected.length<2){
  process.stderr.write('Need at least two Pit cache JSON files.\n');
  process.exitCode=1;
}else{
  const [aRaw,bRaw]=await Promise.all(selected.map(async entry=>JSON.parse(await readFile(entry.path,'utf8'))));
  const [a,b]=[decodeChunk(aRaw),decodeChunk(bRaw)];
  const keys=new Set([...a.keys(),...b.keys()]);
  const transitions=new Map();
  const blockTransitions=new Map();
  const chunkDiffs=new Map();
  const examples=[];
  let changed=0,added=0,removed=0;

  for(const key of keys){
    const av=a.get(key)??0,bv=b.get(key)??0;
    if(av===bv)continue;
    changed++;
    if(av===0)added++;
    if(bv===0)removed++;
    const transition=`${av}->${bv}`;
    transitions.set(transition,(transitions.get(transition)??0)+1);
    const idTransition=`${blockId(av)}:${metadata(av)} -> ${blockId(bv)}:${metadata(bv)}`;
    blockTransitions.set(idTransition,(blockTransitions.get(idTransition)??0)+1);
    const [x,y,z]=key.split(',').map(Number);
    const chunk=`${Math.floor(x/16)},${Math.floor(z/16)}`;
    chunkDiffs.set(chunk,(chunkDiffs.get(chunk)??0)+1);
    if(examples.length<40)examples.push({x,y,z,aState:av,aId:blockId(av),aMeta:metadata(av),bState:bv,bId:blockId(bv),bMeta:metadata(bv)});
  }

  const top=(map,n=25)=>[...map.entries()].sort((x,y)=>y[1]-x[1]).slice(0,n);

  console.log('A',selected[0].name,aRaw.fingerprint,'chunks='+(aRaw.chunks?.length??0),'nodes='+(aRaw.nodes?.length??0));
  console.log('B',selected[1].name,bRaw.fingerprint,'chunks='+(bRaw.chunks?.length??0),'nodes='+(bRaw.nodes?.length??0));
  console.log('');
  console.log('changed blocks:',changed,'added:',added,'removed:',removed);
  console.log('');
  console.log('top blockId:meta transitions');
  for(const [value,count] of top(blockTransitions))console.log(String(count).padStart(7),value);
  console.log('');
  console.log('top raw state transitions');
  for(const [value,count] of top(transitions,15))console.log(String(count).padStart(7),value);
  console.log('');
  console.log('top differing chunks');
  for(const [value,count] of top(chunkDiffs,20))console.log(String(count).padStart(7),value);
  console.log('');
  console.log('first differing coordinates');
  for(const value of examples)console.log(JSON.stringify(value));
}

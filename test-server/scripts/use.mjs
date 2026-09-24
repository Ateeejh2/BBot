import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root=resolve('test-server');
const runtime=resolve(root,'runtime');
const backup=resolve(runtime,'bbot-env-backup');
const envPath=resolve('.env');
await mkdir(runtime,{recursive:true});

async function exists(path){try{await stat(path);return true}catch{return false}}
function setEnv(text,key,value){
  const line=`${key}=${value}`;
  const re=new RegExp(`^${key}=.*$`,'m');
  return re.test(text)?text.replace(re,line):`${text.trimEnd()}\n${line}\n`;
}

if(!(await exists(envPath))){
  const example=resolve('.env.example');
  if(!(await exists(example)))throw new Error('.env and .env.example are missing');
  await copyFile(example,envPath);
}
if(!(await exists(backup)))await copyFile(envPath,backup);

let env=await readFile(envPath,'utf8');
env=setEnv(env,'MODE','live');
env=setEnv(env,'BBOT_TRANSPORT','forge');
env=setEnv(env,'SERVER_HOST','127.0.0.1');
env=setEnv(env,'SERVER_PORT','25567');
env=setEnv(env,'CARE_TEST_SERVER','true');
env=setEnv(env,'PIT_EVENT_MIN_PLAYERS','0');
env=setEnv(env,'DISTRIBUTION_ENABLED','false');
env=setEnv(env,'LOBBY_COMMAND','/l');
await writeFile(envPath,env,{encoding:'utf8',mode:0o600});

process.stdout.write('BBot is configured for the local Care Package test server at 127.0.0.1:25567.\n');
process.stdout.write('Original .env saved to test-server/runtime/bbot-env-backup.\n');
process.stdout.write('Run npm run test-server:restore when finished.\n');

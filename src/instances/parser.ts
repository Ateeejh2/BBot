/** Accept only a whole server notification; player chat prefixes must not match. */
export function parseInstance(message: string): string | undefined {
  const clean = message.replace(/§[0-9a-fk-or]/gi, '').trim();
  return /^SERVER\s+FOUND!\s+Sending\s+to\s+([\w.-]{1,128})!\s*$/i.exec(clean)?.[1]?.toLowerCase();
}


/** Parse Hypixel /locraw output only when it identifies The Pit. */
export function parseLocrawPitInstance(message:string):string|undefined {
  const clean=message.replace(/§[0-9a-fk-or]/gi,'').trim();
  if(clean.length<2||clean.length>1000||clean[0]!=='{'||clean[clean.length-1]!=='}')return undefined;
  try{
    const raw=JSON.parse(clean) as unknown;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return undefined;
    const value=raw as Record<string,unknown>;
    if(typeof value.server!=='string'||!/^[\w.-]{1,128}$/.test(value.server))return undefined;
    const game=typeof value.gametype==='string'?value.gametype.toUpperCase():'';
    const mode=typeof value.mode==='string'?value.mode.toUpperCase():'';
    if(game!=='PIT'&&mode!=='PIT')return undefined;
    return value.server.toLowerCase();
  }catch{
    return undefined;
  }
}

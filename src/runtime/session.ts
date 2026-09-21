import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface SessionCredential {
  accessToken: string;
  clientToken?: string;
  selectedProfile: { name: string; id: string };
}
const opaque = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.length >= 1 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
const sessionInput = (value:unknown): value is string => opaque(value,2200);
const profileName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(value);
const profileId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);

function normalizeAccessToken(value:string):string {
  if(value.startsWith('token:')){
    const last=value.lastIndexOf(':');
    if(last<=6)throw Error('INVALID_SESSION_TOKEN');
    const token=value.slice(6,last);
    const id=value.slice(last+1).replace(/-/g,'');
    if(!opaque(token,2048)||!profileId(id))throw Error('INVALID_SESSION_TOKEN');
    return token;
  }
  return value;
}

export function validateSessionInput(body: unknown): { label: string; accessToken: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('INVALID_INPUT');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== 'accessToken,kind,label' ||
      b.kind !== 'SESSION' || typeof b.label !== 'string' || !/^[\w-]{1,40}$/.test(b.label) ||
      !sessionInput(b.accessToken)) throw Error('INVALID_INPUT');
  return { label: b.label, accessToken: normalizeAccessToken(b.accessToken) };
}

export function validateSessionTokenInput(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('INVALID_INPUT');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).join(',') !== 'accessToken' || !sessionInput(b.accessToken)) throw Error('INVALID_INPUT');
  return normalizeAccessToken(b.accessToken);
}

export async function resolveSessionCredential(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<SessionCredential> {
  accessToken=normalizeAccessToken(accessToken);
  if (!opaque(accessToken, 2048)) throw Error('INVALID_SESSION_TOKEN');
  try {
    const response = await fetchImpl('https://api.minecraftservices.com/minecraft/profile', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw Error('INVALID_SESSION_TOKEN');
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('INVALID_SESSION_TOKEN');
    const profile = raw as Record<string, unknown>;
    if (!profileName(profile.name) || !profileId(profile.id)) throw Error('INVALID_SESSION_TOKEN');
    return {
      accessToken,
      selectedProfile: { name: profile.name, id: profile.id.toLowerCase() }
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_SESSION_TOKEN') throw error;
    throw Error('INVALID_SESSION_TOKEN');
  }
}

export function sessionCredentialPath(authDir: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('INVALID_ACCOUNT_ID');
  return join(authDir, 'session', `${id}.json`);
}
export function readSessionCredential(authDir: string, id: string): SessionCredential {
  const file = sessionCredentialPath(authDir, id);
  try {
    if (statSync(file).size > 8192) throw Error('INVALID_SESSION_CREDENTIAL');
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('INVALID_SESSION_CREDENTIAL');
    const c = raw as Record<string, unknown>;
    const p = c.selectedProfile;
    const keys = Object.keys(c).sort().join(',');
    if (!['accessToken,selectedProfile','accessToken,clientToken,selectedProfile'].includes(keys) ||
        !opaque(c.accessToken, 2048) ||
        (c.clientToken !== undefined && !opaque(c.clientToken, 256)) ||
        !p || typeof p !== 'object' || Array.isArray(p) ||
        Object.keys(p).sort().join(',') !== 'id,name' || !profileName((p as Record<string, unknown>).name) ||
        !profileId((p as Record<string, unknown>).id)) throw Error('INVALID_SESSION_CREDENTIAL');
    return c as unknown as SessionCredential;
  } catch { throw Error('INVALID_SESSION_CREDENTIAL'); }
}
export async function saveSessionCredential(authDir: string, id: string, credential: SessionCredential): Promise<void> {
  const file = sessionCredentialPath(authDir, id);
  const folder = join(authDir, 'session');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(folder, 0o700);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(credential), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } catch { await fs.rm(temp, { force: true }); throw Error('SESSION_SAVE_FAILED'); }
}
export async function deleteSessionCredential(authDir: string, id: string): Promise<void> {
  await fs.rm(sessionCredentialPath(authDir, id), { force: true });
}

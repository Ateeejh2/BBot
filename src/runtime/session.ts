import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface SessionCredential {
  accessToken: string;
  clientToken: string;
  selectedProfile: { name: string; id: string };
}
const uuid = /^[0-9a-f]{32}$|^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const opaque = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.length >= 1 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
const profileName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(value);

export function validateSessionInput(body: unknown): { label: string; credential: SessionCredential } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('INVALID_INPUT');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== 'accessToken,clientToken,kind,label,profileId,profileName' ||
      b.kind !== 'SESSION' || typeof b.label !== 'string' || !/^[\w-]{1,40}$/.test(b.label) ||
      !opaque(b.accessToken, 2048) || !opaque(b.clientToken, 256) ||
      !profileName(b.profileName) || typeof b.profileId !== 'string' || !uuid.test(b.profileId)) throw Error('INVALID_INPUT');
  return { label: b.label, credential: { accessToken: b.accessToken, clientToken: b.clientToken,
    selectedProfile: { name: b.profileName, id: b.profileId.replace(/-/g, '').toLowerCase() } } };
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
    if (Object.keys(c).sort().join(',') !== 'accessToken,clientToken,selectedProfile' ||
        !opaque(c.accessToken, 2048) || !opaque(c.clientToken, 256) || !p || typeof p !== 'object' || Array.isArray(p) ||
        Object.keys(p).sort().join(',') !== 'id,name' || !profileName((p as Record<string, unknown>).name) ||
        typeof (p as Record<string, unknown>).id !== 'string' || !/^[0-9a-f]{32}$/.test((p as Record<string, unknown>).id as string)) throw Error('INVALID_SESSION_CREDENTIAL');
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

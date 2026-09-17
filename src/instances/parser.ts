/** Accept only a whole server notification; player chat prefixes must not match. */
export function parseInstance(message: string): string | undefined {
  const clean = message.replace(/§[0-9a-fk-or]/gi, '').trim();
  return /^SERVER\s+FOUND!\s+Sending\s+to\s+([\w.-]{1,128})!\s*$/i.exec(clean)?.[1]?.toLowerCase();
}

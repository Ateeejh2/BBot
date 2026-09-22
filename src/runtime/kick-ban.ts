export type DisconnectModerationKind = 'KICK' | 'BAN';

export interface PersistedBan {
  kind: 'BAN';
  reason: string;
  detectedAt: number;
}

const BAN_PATTERNS = [
  /\b(?:temporarily|permanently)\s+banned\b/i,
  /\byou(?: are|'re)?\s+banned\b/i,
  /\byour account (?:is|has been)\s+banned\b/i,
  /\baccount banned\b/i,
  /\bbanned from (?:this|the) server\b/i,
  /\bban id\b/i
];

export function classifyDisconnectReason(reason: string): DisconnectModerationKind {
  const normalized = reason.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return BAN_PATTERNS.some(pattern => pattern.test(normalized)) ? 'BAN' : 'KICK';
}

export function validPersistedBan(value: unknown): value is PersistedBan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ban = value as Record<string, unknown>;
  return ban.kind === 'BAN' &&
    typeof ban.reason === 'string' && ban.reason.length > 0 && ban.reason.length <= 160 &&
    !/[\u0000-\u001f\u007f]/.test(ban.reason) &&
    Number.isSafeInteger(ban.detectedAt) && (ban.detectedAt as number) >= 0;
}

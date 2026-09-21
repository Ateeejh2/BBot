/** Position is reported by Mineflayer. Legacy 1.8.9 chat sender metadata is not authoritative.
 * For chat, accept sender-marked content only when it exactly matches the transfer notification parser.
 */
export function eligibleTransferChannel(
  position: string,
  sender: string | null | undefined,
  selected: 'system' | 'chat',
  exactTransfer = false
): boolean {
  // An exact whole-line transfer notification with no sender is authoritative
  // on legacy 1.8.9 whether Forge/Mineflayer classifies it as chat or system.
  // Ordinary messages still obey the configured channel.
  if (exactTransfer && !sender && (position === 'system' || position === 'chat')) return true;
  if (position !== selected) return false;
  if (!sender) return true;
  return selected === 'chat' && exactTransfer;
}


/** Exact server event announcements may arrive as chat or system on legacy protocol.
 * Require sender-less text so ordinary player chat cannot trigger server event automation.
 */
export function eligibleServerAnnouncementChannel(
  position: string,
  sender: string | null | undefined,
  exactAnnouncement: boolean
): boolean {
  return exactAnnouncement && !sender && (position === 'system' || position === 'chat');
}


/** Exact Hypixel Limbo notice. Matching the entire normalized line prevents a
 * normal player message such as "<name>: You were spawned in Limbo." from
 * triggering recovery.
 */
export function isLimboNotice(text: string): boolean {
  return text.replace(/§[0-9A-FK-OR]/gi, '').replace(/\s+/g, ' ').trim() === 'You were spawned in Limbo.';
}


/** Exact Pit death recap line. Player chat includes a sender/prefix, so anchoring
 * the whole normalized line prevents players from spoofing this event.
 */
export function isDeathNotice(text: string): boolean {
  const normalized=text.replace(/§[0-9A-FK-OR]/gi, '').replace(/\s+/g, ' ').trim();
  return /^DEATH!\s+by\s+.+?\s+VIEW RECAP$/i.test(normalized);
}

/** Position is reported by Mineflayer. Legacy 1.8.9 chat sender metadata is not authoritative.
 * For chat, accept sender-marked content only when it exactly matches the transfer notification parser.
 */
export function eligibleTransferChannel(
  position: string,
  sender: string | null | undefined,
  selected: 'system' | 'chat',
  exactTransfer = false
): boolean {
  if (position !== selected) return false;
  if (!sender) return true;
  return selected === 'chat' && exactTransfer;
}

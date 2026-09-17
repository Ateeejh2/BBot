/** Position is reported by Mineflayer. Legacy chat has no verified sender identity. */
export function eligibleTransferChannel(position: string, sender: string | null | undefined, selected: 'system' | 'chat'): boolean {
  return !sender && position === selected;
}

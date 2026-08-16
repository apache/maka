export interface ChatConversationItem<T> {
  readonly afterTurnId: string;
  readonly renderWhenAnchorMissing?: boolean;
  readonly value: T;
}

export function placeChatConversationItems<T>(
  items: readonly ChatConversationItem<T>[],
  residentTurnIds: ReadonlySet<string>,
): { byTurn: ReadonlyMap<string, readonly T[]>; orphan: T | undefined } {
  const byTurn = new Map<string, T[]>();
  let orphan: T | undefined;
  for (const item of items) {
    if (residentTurnIds.has(item.afterTurnId)) {
      const current = byTurn.get(item.afterTurnId) ?? [];
      current.push(item.value);
      byTurn.set(item.afterTurnId, current);
    } else if (item.renderWhenAnchorMissing) {
      orphan = item.value;
    }
  }
  return { byTurn, orphan };
}

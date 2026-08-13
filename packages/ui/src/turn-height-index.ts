interface SessionTurnHeights {
  layoutKey: string;
  heights: Map<string, number>;
}

export interface TurnHeightIndex {
  lookup(sessionId: string, layoutKey: string): ReadonlyMap<string, number> | undefined;
  record(sessionId: string, layoutKey: string, turnId: string, height: number): boolean;
}

export function turnLayoutKey(root: HTMLElement): string {
  const column = root.querySelector<HTMLElement>('.maka-chat-message-list');
  return `${Math.round((column ?? root).clientWidth)}:${root.dataset.density ?? ''}`;
}

export function createTurnHeightIndex(sessionCapacity = 12, turnCapacity = 1_024): TurnHeightIndex {
  const sessions = new Map<string, SessionTurnHeights>();

  const entryFor = (sessionId: string, layoutKey: string): SessionTurnHeights => {
    const current = sessions.get(sessionId);
    if (current?.layoutKey === layoutKey) {
      sessions.delete(sessionId);
      sessions.set(sessionId, current);
      return current;
    }
    const next = { layoutKey, heights: new Map<string, number>() };
    sessions.delete(sessionId);
    sessions.set(sessionId, next);
    while (sessions.size > sessionCapacity) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return next;
  };

  return {
    lookup(sessionId, layoutKey) {
      const entry = sessions.get(sessionId);
      if (entry?.layoutKey !== layoutKey) return undefined;
      sessions.delete(sessionId);
      sessions.set(sessionId, entry);
      return entry.heights;
    },
    record(sessionId, layoutKey, turnId, height) {
      if (!Number.isFinite(height) || height <= 0) return false;
      const entry = entryFor(sessionId, layoutKey);
      const previous = entry.heights.get(turnId);
      if (previous !== undefined && Math.abs(previous - height) < 0.5) return false;
      entry.heights.delete(turnId);
      entry.heights.set(turnId, height);
      while (entry.heights.size > turnCapacity) {
        const oldest = entry.heights.keys().next().value;
        if (oldest === undefined) break;
        entry.heights.delete(oldest);
      }
      return true;
    },
  };
}

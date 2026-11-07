/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
/** Match the legacy transcript: newest messages first, including replies above their prompts. */
export function quickAssistantOrder(
  entries: readonly {
    key: string;
    turn?: string;
    kind: string;
    role?: string;
  }[],
): string[] {
  const turns = new Map<string, string[]>();
  for (const entry of entries) {
    if (
      !['bot', 'botWorking', 'botWaiting', 'botNote'].includes(entry.kind) &&
      entry.role !== 'user'
    )
      continue;
    const key = entry.turn ?? 'latest';
    const group = turns.get(key) ?? [];
    group.push(entry.key);
    turns.set(key, group);
  }
  return [...turns.values()].reverse().flatMap((group) => group.reverse());
}

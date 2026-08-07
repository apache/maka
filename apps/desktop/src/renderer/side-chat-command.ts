export interface SideChatCommand {
  prompt: string;
}

export function parseSideChatCommand(input: string): SideChatCommand | null {
  const match = /^\s*\/side(?:\s+([\s\S]*?))?\s*$/.exec(input);
  return match ? { prompt: match[1]?.trim() ?? '' } : null;
}

export function sideChatTitleFromPrompt(input: string): string | undefined {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, 60).join('');
}

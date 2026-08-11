import type { OrchestrationMode } from './orchestration.js';

export type ParsedDelegateCommand =
  | { kind: 'status' }
  | { kind: 'set_mode'; mode: OrchestrationMode }
  | { kind: 'run_once'; task: string };

/** Parse the exact `/delegate` command without treating lookalike prompts as commands. */
export function parseDelegateCommand(input: string): ParsedDelegateCommand | null {
  const trimmed = input.trim();
  const commandToken = trimmed.split(/\s+/, 1)[0] ?? '';
  if (commandToken !== '/delegate') return null;

  const tail = trimmed.slice(commandToken.length).trim();
  if (!tail || tail === 'status') return { kind: 'status' };
  if (tail === 'on') return { kind: 'set_mode', mode: 'delegate' };
  if (tail === 'off') return { kind: 'set_mode', mode: 'default' };
  return { kind: 'run_once', task: tail };
}

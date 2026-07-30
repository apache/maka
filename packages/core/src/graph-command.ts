import type { OrchestrationMode } from './orchestration.js';

export type ParsedGraphCommand =
  | { kind: 'status' }
  | { kind: 'set_mode'; mode: OrchestrationMode }
  | { kind: 'run_once'; task: string };

/** Parse the exact `/graph` command without treating lookalike prompts as commands. */
export function parseGraphCommand(input: string): ParsedGraphCommand | null {
  const trimmed = input.trim();
  const commandToken = trimmed.split(/\s+/, 1)[0] ?? '';
  if (commandToken !== '/graph') return null;

  const tail = trimmed.slice(commandToken.length).trim();
  if (!tail || tail === 'status') return { kind: 'status' };
  if (tail === 'on') return { kind: 'set_mode', mode: 'graph' };
  if (tail === 'off') return { kind: 'set_mode', mode: 'default' };
  return { kind: 'run_once', task: tail };
}

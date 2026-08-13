import { parseGraphCommand, type ParsedGraphCommand } from '@maka/core/graph-command';
import { parseSwarmCommand, type ParsedSwarmCommand } from '@maka/core/swarm-command';
import { parseSideChatCommand, type SideChatCommand } from './side-chat-command.js';

export type DesktopSlashCommand =
  | { kind: 'compact' }
  | { kind: 'side'; command: SideChatCommand }
  | { kind: 'graph'; command: ParsedGraphCommand }
  | { kind: 'swarm'; command: ParsedSwarmCommand };

/** Classify input with the same parsers that own Desktop command execution. */
export function parseDesktopSlashCommand(input: string): DesktopSlashCommand | null {
  if (input.trim() === '/compact') return { kind: 'compact' };
  const side = parseSideChatCommand(input);
  if (side) return { kind: 'side', command: side };
  const graph = parseGraphCommand(input);
  if (graph) return { kind: 'graph', command: graph };
  const swarm = parseSwarmCommand(input);
  return swarm ? { kind: 'swarm', command: swarm } : null;
}

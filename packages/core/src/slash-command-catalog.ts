export type SlashCommandTail = 'none' | 'optional' | 'required';
export type SlashCommandSessionRequirement = 'none' | 'required';
export type SlashCommandSurface = 'desktop' | 'tui';

export interface SlashCommandSpec {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly tail: SlashCommandTail;
  readonly session: SlashCommandSessionRequirement;
  readonly surfaces: readonly SlashCommandSurface[];
}

export const SLASH_COMMAND_CATALOG = [
  { id: 'compact', tail: 'none', session: 'required', surfaces: ['desktop', 'tui'] },
  { id: 'context', tail: 'none', session: 'required', surfaces: ['tui'] },
  { id: 'exit', aliases: ['quit'], tail: 'none', session: 'none', surfaces: ['tui'] },
  { id: 'graph', tail: 'optional', session: 'required', surfaces: ['desktop', 'tui'] },
  { id: 'help', tail: 'none', session: 'none', surfaces: ['tui'] },
  { id: 'model', tail: 'optional', session: 'required', surfaces: ['tui'] },
  { id: 'move', tail: 'optional', session: 'required', surfaces: ['tui'] },
  { id: 'new', tail: 'none', session: 'none', surfaces: ['tui'] },
  { id: 'permissions', tail: 'optional', session: 'required', surfaces: ['tui'] },
  { id: 'recap', tail: 'none', session: 'required', surfaces: ['tui'] },
  { id: 'rename', tail: 'required', session: 'required', surfaces: ['tui'] },
  { id: 'resume', tail: 'none', session: 'required', surfaces: ['tui'] },
  { id: 'rewind', tail: 'none', session: 'required', surfaces: ['tui'] },
  { id: 'session', tail: 'optional', session: 'none', surfaces: ['tui'] },
  { id: 'setup', tail: 'none', session: 'none', surfaces: ['tui'] },
  { id: 'side', tail: 'optional', session: 'required', surfaces: ['desktop'] },
  { id: 'skill', tail: 'none', session: 'required', surfaces: ['tui'] },
  { id: 'swarm', tail: 'optional', session: 'required', surfaces: ['desktop', 'tui'] },
  { id: 'thinking', tail: 'optional', session: 'required', surfaces: ['tui'] },
] as const satisfies readonly SlashCommandSpec[];

export type SlashCommandId = (typeof SLASH_COMMAND_CATALOG)[number]['id'];

const SLASH_COMMAND_BY_ID = new Map(SLASH_COMMAND_CATALOG.map((command) => [command.id, command]));

export function slashCommandSpec(id: SlashCommandId): SlashCommandSpec {
  return SLASH_COMMAND_BY_ID.get(id)!;
}

export function slashCommandsForSurface(surface: SlashCommandSurface) {
  return SLASH_COMMAND_CATALOG.filter((command) =>
    (command.surfaces as readonly SlashCommandSurface[]).includes(surface),
  );
}

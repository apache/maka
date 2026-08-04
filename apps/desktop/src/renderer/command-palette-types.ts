/**
 * Shared types for the Command Palette. Pulled out of
 * `command-palette.tsx` so non-JSX consumers can import them under the
 * main-process tsconfig that does not compile JSX.
 */

import type { LucideIcon } from '@maka/ui/icons';

export type CommandKind = 'action' | 'session';

export interface Command {
  id: string;
  kind: CommandKind;
  label: string;
  hint?: string;
  group: string;
  Icon: LucideIcon;
  keywords?: string[];
  run(): void | Promise<void>;
}

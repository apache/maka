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
  /**
   * When `true`, the palette treats this command as inert:
   *   - `commit()` returns immediately without firing `run()` or
   *     closing the dialog.
   *   - The rendered `<button>` carries `aria-disabled="true"` so a11y
     *     tools announce the state correctly; CSS may grey it out via
   *     the `data-disabled` attribute.
   *
   * Used by PR-SEARCH-2.6 content-search tiles for `blocked` /
   * `loading` / `error` / empty states. Hits themselves are NOT
   * disabled.
   */
  disabled?: boolean;
  run(): void | Promise<void>;
}

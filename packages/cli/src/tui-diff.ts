import { parseUnifiedDiffRows, type UnifiedDiffRow } from '@maka/core/unified-diff';
import { ansi } from './tui-ansi.js';

/**
 * Diff coloring for the transcript, over the shared structural parse in
 * `@maka/core`. The parse drives classification with the declared hunk
 * counts, so a deleted `-- `-prefixed line colors red instead of dimming as
 * a false file header, and file headers (`---`/`+++`/`index`) never reach
 * the transcript at all. Hunk headers stay: they are the only line-number
 * anchor in the terminal rendering.
 */
export function colorDiffRow(row: UnifiedDiffRow): string {
  switch (row.kind) {
    case 'add':
      return ansi.green(row.text);
    case 'del':
      return ansi.red(row.text);
    case 'hunk':
      return ansi.accent(row.text);
    case 'meta':
      return ansi.dim(row.text);
    case 'ctx':
      return row.text;
  }
}

/** Color a whole diff body, preserving line breaks. */
export function colorDiff(diff: string): string {
  return parseUnifiedDiffRows(diff).map(colorDiffRow).join('\n');
}

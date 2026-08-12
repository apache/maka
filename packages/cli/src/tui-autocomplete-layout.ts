import type { Component, Editor } from '@earendil-works/pi-tui';
import { selectListTheme, stripAnsi } from './tui-ansi.js';

// The pi-tui Editor renders its autocomplete menu at the tail of its render
// output, i.e. below the input box. The Maka TUI pins the input at the bottom
// of the screen, so those suggestions must appear *above* the editor instead.
//
// Editor exposes no way to render the menu on its own (only isShowingAutocomplete()),
// so this module post-processes the lines Editor.render() returns: it locates the
// editor's chrome borders and moves the trailing suggestion block above them.
// The same adapter owns the viewport fit. The vendor SelectList captures its
// max height when it opens, so changing Editor's option during a terminal resize
// cannot resize the active list; fitting the rendered rows here preserves its
// selected index while keeping that selected row inside Maka's live viewport.
//
// Fragile by necessity: isEditorChromeLine pattern-matches the editor's border
// lines (all-dash) and scroll hint ("--- UP/DOWN N more ---"). If pi-tui changes
// those shapes, this split silently misfires (suggestions vanish or land wrong)
// with no compile error. Re-verify these patterns whenever pi-tui is upgraded.

export interface MakaAutocompleteArrangementInput {
  lines: string[];
  autocompleteShowing: boolean;
  autocompleteSlotRows: number;
  viewportRows: number;
}

export interface MakaAutocompleteArrangementResult {
  lines: string[];
  autocompleteSlotRows: number;
  editorRows: number;
}

export function arrangeAutocompleteAboveEditor(
  input: MakaAutocompleteArrangementInput,
): MakaAutocompleteArrangementResult {
  if (!input.autocompleteShowing) {
    return { lines: input.lines, autocompleteSlotRows: 0, editorRows: input.lines.length };
  }
  const sections = splitTrailingAutocomplete(input.lines);
  if (sections.autocompleteLines.length === 0) {
    return {
      lines: sections.editorLines,
      autocompleteSlotRows: 0,
      editorRows: sections.editorLines.length,
    };
  }
  const autocompleteRowsAvailable = Math.max(
    0,
    Math.floor(input.viewportRows) - sections.editorLines.length,
  );
  const autocompleteLines = fitAutocompleteLines(
    sections.autocompleteLines,
    autocompleteRowsAvailable,
    selectListTheme().scrollInfo,
  );
  const autocompleteSlotRows = Math.min(
    autocompleteRowsAvailable,
    Math.max(input.autocompleteSlotRows, autocompleteLines.length),
  );
  return {
    lines: [
      ...Array.from({ length: autocompleteSlotRows - autocompleteLines.length }, () => ''),
      ...autocompleteLines,
      ...sections.editorLines,
    ],
    autocompleteSlotRows,
    editorRows: sections.editorLines.length,
  };
}

export class MakaAutocompleteAboveEditorComponent implements Component {
  private autocompleteSlotRows = 0;
  private viewportRows = Number.POSITIVE_INFINITY;
  private editorRows = 3;

  constructor(private readonly editor: Editor) {}

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  setViewportRows(rows: number): void {
    this.viewportRows = Math.max(0, Math.floor(rows));
  }

  isShowingAutocomplete(): boolean {
    return this.editor.isShowingAutocomplete();
  }

  minimumViewportRows(): number {
    return this.editorRows + (this.editor.isShowingAutocomplete() ? 1 : 0);
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const lines = this.editor.render(width);
    const result = arrangeAutocompleteAboveEditor({
      lines,
      autocompleteShowing: this.editor.isShowingAutocomplete(),
      autocompleteSlotRows: this.autocompleteSlotRows,
      viewportRows: this.viewportRows,
    });
    this.autocompleteSlotRows = result.autocompleteSlotRows;
    this.editorRows = result.editorRows;
    return result.lines;
  }
}

export function fitAutocompleteLines(
  lines: readonly string[],
  maxRows: number,
  formatScrollInfo: (text: string) => string = (text) => text,
): string[] {
  const rowBudget = Math.max(0, Math.floor(maxRows));
  if (lines.length <= rowBudget) return [...lines];
  if (rowBudget === 0) return [];

  const trailingScrollInfo = parseScrollInfo(lines.at(-1));
  const itemLines = trailingScrollInfo ? lines.slice(0, -1) : lines;
  const selectedIndex = Math.max(
    0,
    itemLines.findIndex((line) => /^\s*→/.test(stripAnsi(line))),
  );
  if (rowBudget === 1) return [itemLines[selectedIndex] ?? itemLines[0] ?? ''];

  const itemBudget = rowBudget - 1;
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(itemBudget / 2), itemLines.length - itemBudget),
  );
  const selectedPosition = trailingScrollInfo?.position ?? selectedIndex + 1;
  const total = trailingScrollInfo?.total ?? itemLines.length;
  return [
    ...itemLines.slice(startIndex, startIndex + itemBudget),
    formatScrollInfo(`  (${selectedPosition}/${total})`),
  ];
}

interface MakaAutocompleteSections {
  autocompleteLines: string[];
  editorLines: string[];
}

function splitTrailingAutocomplete(lines: string[]): MakaAutocompleteSections {
  const bottomBorderIndex = findLastIndex(lines, isEditorChromeLine);
  if (bottomBorderIndex < 1 || bottomBorderIndex === lines.length - 1) {
    return { autocompleteLines: [], editorLines: lines };
  }
  const topBorderIndex = findLastIndex(lines.slice(0, bottomBorderIndex), isEditorChromeLine);
  if (topBorderIndex < 0) return { autocompleteLines: [], editorLines: lines };

  return {
    autocompleteLines: lines.slice(bottomBorderIndex + 1),
    editorLines: lines.slice(0, bottomBorderIndex + 1),
  };
}

function isEditorChromeLine(line: string): boolean {
  const text = stripAnsi(line);
  return /^─+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

function parseScrollInfo(line: string | undefined): { position: number; total: number } | null {
  if (!line) return null;
  const match = /^\s*\((\d+)\/(\d+)\)\s*$/.exec(stripAnsi(line));
  if (!match) return null;
  return { position: Number(match[1]), total: Number(match[2]) };
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

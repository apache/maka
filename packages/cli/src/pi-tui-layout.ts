import { Container, type Component, type Terminal } from '@earendil-works/pi-tui';
// Deep import (pi-tui does not re-export it): the viewport shadow diff must
// compare the same canonical lines pi-tui diffs, and pi-tui normalizes Thai/Lao
// AM sequences before its diff. Pinned to pi-tui 0.80.3.
import { normalizeTerminalOutput } from '@earendil-works/pi-tui/dist/utils.js';
import {
  renderMakaPiActivityStrip,
  renderMakaPiPendingQueue,
  renderMakaPiStatusLine,
  renderMakaPiTranscript,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
} from './pi-transcript.js';

interface ViewportAwareEditor extends Component {
  setViewportRows(rows: number): void;
  isShowingAutocomplete(): boolean;
  minimumViewportRows(): number;
}

export function fitPendingQueueLines(lines: readonly string[], maxRows: number): string[] {
  const rowBudget = Math.max(0, Math.floor(maxRows));
  if (lines.length <= rowBudget) return [...lines];
  if (rowBudget === 0) return [];
  if (rowBudget === 1) return [`… ${lines.length} more`];
  return [...lines.slice(0, rowBudget - 1), `… ${lines.length - rowBudget + 1} more`];
}

export class MakaTranscriptComponent implements Component {
  constructor(
    private readonly state: MakaPiTranscriptState,
    private readonly metadata: () => MakaPiTranscriptMetadata,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderMakaPiTranscript(this.state, this.metadata(), width);
  }
}

export class MakaStatusLineComponent implements Component {
  constructor(private readonly metadata: () => MakaPiTranscriptMetadata) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [renderMakaPiStatusLine(this.metadata(), width)];
  }
}

export class MakaActivityStripComponent implements Component {
  constructor(private readonly metadata: () => MakaPiTranscriptMetadata) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [renderMakaPiActivityStrip(this.metadata(), width)];
  }
}

/** The pending-queue bar (Steering:/Queued:) rendered just above the editor. */
export class MakaPendingQueueComponent implements Component {
  constructor(private readonly state: MakaPiTranscriptState) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderMakaPiPendingQueue(this.state, width);
  }
}

/**
 * Stacks the transcript above the editor and status line. The transcript is
 * never windowed: every line is emitted and, when the whole document is taller
 * than the terminal, pi-tui's differential renderer scrolls older output into
 * the terminal's own scrollback (exactly as the upstream Pi TUI does). History
 * is scrolled with the terminal/trackpad rather than an in-app pager, so long
 * output is never truncated.
 *
 * The only layout work is bottom-anchoring: while the transcript fits, blank
 * rows pad it up so the editor and status line sit at the bottom of the screen.
 * Once it overflows the padding is gone and the buffer grows past the viewport.
 */
export class MakaPiLayoutComponent extends Container {
  /** Composed lines of the previous render, for the viewport-top shadow diff. */
  private previousLines: string[] | undefined;
  private previousRows: number | undefined;
  private previousWidth: number | undefined;

  constructor(
    private readonly state: MakaPiTranscriptState,
    private readonly transcript: MakaTranscriptComponent,
    private readonly activityStrip: MakaActivityStripComponent,
    private readonly pendingQueue: MakaPendingQueueComponent,
    private readonly editor: ViewportAwareEditor,
    private readonly statusLine: Component,
    private readonly terminal: Terminal,
  ) {
    super();
    this.addChild(transcript);
    this.addChild(activityStrip);
    this.addChild(pendingQueue);
    this.addChild(editor);
    this.addChild(statusLine);
  }

  render(width: number): string[] {
    const transcriptLines = this.transcript.render(width);
    const activityLines = this.activityStrip.render(width);
    const allPendingLines = this.pendingQueue.render(width);
    const statusLines = this.statusLine.render(width);
    const pendingRowsAvailable = this.editor.isShowingAutocomplete()
      ? Math.max(
          0,
          this.terminal.rows -
            activityLines.length -
            statusLines.length -
            this.editor.minimumViewportRows(),
        )
      : allPendingLines.length;
    const pendingLines = fitPendingQueueLines(allPendingLines, pendingRowsAvailable);
    this.editor.setViewportRows(
      this.terminal.rows - activityLines.length - pendingLines.length - statusLines.length,
    );
    const editorLines = this.editor.render(width);
    // #1064: when the activity strip is showing (a turn is running), separate
    // it from the last transcript line with a blank row. Without this, a
    // thinking or tool row (the agent-work stack, which has no internal blank
    // gaps) sits directly against `Working… 12s`.
    const activityActive =
      activityLines.length > 0 && activityLines.some((line) => line.length > 0);
    const lastTranscriptLine = transcriptLines[transcriptLines.length - 1];
    const needGap =
      activityActive && lastTranscriptLine !== undefined && lastTranscriptLine.length > 0;
    const paddedTranscript = needGap ? [...transcriptLines, ''] : transcriptLines;
    const chromeRows =
      activityLines.length + pendingLines.length + editorLines.length + statusLines.length;
    const viewportRows = Math.max(0, this.terminal.rows - chromeRows);
    const paddingRows = Math.max(0, viewportRows - paddedTranscript.length);
    const lines = [
      ...paddedTranscript,
      ...Array.from({ length: paddingRows }, () => ''),
      ...activityLines,
      ...pendingLines,
      ...editorLines,
      ...statusLines,
    ];
    // #1097: record where pi-tui's live viewport starts for this render, in
    // transcript-line coordinates (valid because the transcript opens this
    // composed list at line 0). The expansion toggles use it to leave entries
    // above the viewport untouched — their lines sit in scrollback, which
    // cannot be rewritten without a scrollback-clearing full redraw.
    //
    // Shadow pi-tui's own viewport rule rather than guessing: its viewport
    // never scrolls back up (monotonic max) except when it full-redraws and
    // re-anchors to the document tail. Each branch of nextViewportTop mirrors
    // one decision in pi-tui's doRender (tui.js, pinned 0.80.3); the estimate
    // may exceed the real viewport top (which only makes the toggles more
    // conservative) but must never fall below it. An upstream viewport getter
    // would collapse all of this to one line.
    const normalized = lines.map(normalizeTerminalOutput);
    this.state.renderGeometry.viewportTop = this.nextViewportTop(normalized, width);
    this.previousLines = normalized;
    this.previousRows = this.terminal.rows;
    this.previousWidth = width;
    return lines;
  }

  /** `lines` are normalized, matching what pi-tui's differential renderer diffs. */
  private nextViewportTop(lines: string[], width: number): number {
    const rows = this.terminal.rows;
    const tailTop = Math.max(0, lines.length - rows);
    const previous = this.previousLines;
    // First render; width changes full-redraw unconditionally (tui.js ~1061),
    // even when no line ends up wrapping differently.
    if (previous === undefined || this.previousWidth !== width) return tailTop;
    const current = this.state.renderGeometry.viewportTop;
    if (this.previousRows !== rows) {
      // Height changes full-redraw (tui.js ~1069) except under Termux, where
      // the software keyboard resizes constantly and pi-tui instead keeps the
      // buffer and recomputes its top from it (tui.js ~983).
      return Boolean(process.env.TERMUX_VERSION)
        ? Math.max(tailTop, current + (this.previousRows ?? rows) - rows)
        : tailTop;
    }
    // Any change above the viewport top forces a full redraw (tui.js ~1169).
    const scan = Math.min(previous.length, lines.length);
    let firstChanged = -1;
    for (let i = 0; i < scan; i += 1) {
      if (previous[i] !== lines[i]) {
        firstChanged = i;
        break;
      }
    }
    if (firstChanged !== -1 && firstChanged < current) return tailTop;
    if (lines.length < previous.length) {
      // Pure truncation: pi-tui's deleted-lines path full-redraws when the
      // new document ends at or above the viewport top (tui.js ~1122,
      // `targetRow < prevViewportTop`) or when more than a screenful of rows
      // must be cleared (tui.js ~1136); a shallower truncation keeps the
      // viewport where it was.
      if (lines.length <= current) return tailTop;
      if (firstChanged === -1 && previous.length - lines.length > rows) return tailTop;
    }
    return Math.max(current, tailTop);
  }
}

/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Container, type Component, type Terminal } from '@earendil-works/pi-tui';
// Deep import (pi-tui does not re-export it): the viewport shadow diff must
// compare the same canonical lines pi-tui diffs, and pi-tui normalizes Thai/Lao
// AM sequences before its diff. Pinned to pi-tui 0.80.3.
import { normalizeTerminalOutput } from '@earendil-works/pi-tui/dist/utils.js';
// Separate statement, anchored below the deep import rather than appended to
// the Container import: upstream inserts its UiLocale import directly after
// the Container line, and an import here keeps the two changes in different
// diff gaps so the three-way merge resolves cleanly.
import { ScrollView } from '@earendil-works/pi-tui';
import {
  renderMakaPiActivityStrip,
  renderMakaPiPendingQueue,
  renderMakaPiStatusLine,
  renderMakaPiTranscript,
  type MakaPiTranscriptEntry,
  type MakaPiTranscriptMetadata,
  type MakaPiTranscriptState,
} from './pi-transcript.js';
import type { ScrollViewOptions } from '@earendil-works/pi-tui';
import type { UnreadOutputFeed } from './tui-fullscreen.js';
import { renderUnreadIndicator, UnreadOutputCounter } from './tui-fullscreen.js';

interface ViewportAwareEditor extends Component {
  setViewportRows(rows: number): void;
  isShowingAutocomplete(): boolean;
  minimumViewportRows(): number;
}

/** Rows the transcript keeps in the fullscreen layout even on tiny terminals. */
const FULLSCREEN_TRANSCRIPT_MIN_ROWS = 1;

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

  /**
   * Render the complete current projection without changing the geometry used
   * by the live terminal-scrollback reconciliation path.
   */
  createDocumentRenderer(): (width: number) => string[] {
    // The detached keys and their rendered-line cache live only as long as one
    // viewer overlay. Closing it releases the complete duplicate projection.
    const entryClones = new WeakMap<MakaPiTranscriptEntry, MakaPiTranscriptEntry>();
    const documentEntry = (entry: MakaPiTranscriptEntry): MakaPiTranscriptEntry => {
      const cached = entryClones.get(entry);
      if (cached) {
        Object.assign(cached, entry);
        return cached;
      }
      const clone = { ...entry } as MakaPiTranscriptEntry;
      entryClones.set(entry, clone);
      return clone;
    };
    return (width) =>
      renderMakaPiTranscript(
        {
          ...this.state,
          entries: this.state.entries.map(documentEntry),
          renderGeometry: { entryFirstLine: undefined, viewportTop: 0 },
        },
        this.metadata(),
        width,
      );
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

/**
 * The ScrollView child of the fullscreen layout: renders the complete
 * transcript document (the scroll view windows it) and exposes the rendered
 * line count so the scroll view can count lines appended while the user is
 * scrolled away. Lives in pi-tui-layout.ts alongside the other transcript
 * adapters.
 */
export class MakaTranscriptDocumentComponent implements Component {
  /** Rendered transcript document lines from the most recent frame. */
  documentLines = 0;

  constructor(private readonly transcript: MakaTranscriptComponent) {}

  invalidate(): void {
    this.transcript.invalidate();
  }

  render(width: number): string[] {
    const lines = this.transcript.render(width);
    this.documentLines = lines.length;
    return lines;
  }
}

/**
 * The fullscreen layout's transcript scroll view. `ScrollView.updateLayout`
 * runs at the layout pass with this frame's content height and scroll state —
 * the one point in the frame where the window is fresh — so this subclass
 * computes the unread count there and compares it with what the anchored
 * chrome actually rendered (`presentedUnread`, written back by the chrome via
 * its `UnreadOutputFeed`). The chrome is measured before the scroll view is
 * laid out, so its view lags one frame; when the rendered count falls behind,
 * a catch-up render is requested and the indicator settles deterministically.
 */
export class MakaTranscriptScrollView extends ScrollView {
  /** Unread count as of the most recent layout pass. */
  computedUnread = 0;
  /** Unread count the chrome last rendered. */
  presentedUnread = 0;

  private readonly counter = new UnreadOutputCounter();

  constructor(
    private readonly document: MakaTranscriptDocumentComponent,
    options: ScrollViewOptions,
  ) {
    super(document, options);
  }

  override updateLayout(
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    this.computedUnread = this.counter.update({
      followingEnd: this.isFollowingEnd,
      documentLines: this.document.documentLines,
    });
    if (this.computedUnread !== this.presentedUnread) requestRender();
  }
}

/**
 * The anchored bottom chrome of the fullscreen layout (issue #4136): unread
 * indicator, activity strip, pending queue, editor, and status line — stacked
 * below the scrolling transcript and pinned to the screen bottom by the
 * VStack. The transcript region above owns its own scrolling, so unlike
 * `MakaPiLayoutComponent` this component emits only the chrome rows and never
 * pads or windows the transcript.
 *
 * The unread count comes from the scroll view's `UnreadOutputFeed` (see
 * `MakaTranscriptScrollView`): the layout engine measures this component
 * before the scroll view is laid out, so the count it reads lags one frame and
 * the scroll view requests a catch-up render whenever the rendered count falls
 * behind.
 *
 * `renderGeometry.viewportTop` is pinned to 0: the app owns the whole screen,
 * no rendered line sits in untouchable terminal scrollback, so the
 * entry-freeze and viewport-restricted expansion toggles that main-screen mode
 * needs (#1097, #1134, #4011) must not engage — every entry stays
 * re-renderable and globally toggleable.
 */
export class MakaFullscreenChromeComponent implements Component {
  constructor(
    private readonly state: MakaPiTranscriptState,
    private readonly activityStrip: MakaActivityStripComponent,
    private readonly pendingQueue: MakaPendingQueueComponent,
    private readonly editor: ViewportAwareEditor,
    private readonly statusLine: Component,
    private readonly terminal: Terminal,
    private readonly unreadFeed: UnreadOutputFeed,
    private readonly accent: (text: string) => string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const unreadLines = this.unreadFeed.current();
    const indicatorLines = renderUnreadIndicator(unreadLines, this.accent);
    this.unreadFeed.present(unreadLines);
    // App-owned viewport: no terminal scrollback exists, so expansion toggles
    // may retarget any entry and no entry is ever frozen off-screen.
    this.state.renderGeometry.viewportTop = 0;

    const allActivityLines = this.activityStrip.render(width);
    // The activity strip renders one row even when idle (an empty string);
    // an all-empty strip would burn a permanent chrome row between the
    // transcript and the editor, so it collapses to nothing when idle.
    const activityRows = allActivityLines.some((line) => line.length > 0) ? allActivityLines : [];
    const allPendingLines = this.pendingQueue.render(width);
    const statusLines = this.statusLine.render(width);
    // Same editor/autocomplete fixed-point as MakaPiLayoutComponent, with the
    // transcript's minimum row and the indicator reserved up front so the
    // chrome's intrinsic height can never push the transcript below one row.
    const editorBudget = Math.max(
      0,
      this.terminal.rows -
        indicatorLines.length -
        activityRows.length -
        statusLines.length -
        FULLSCREEN_TRANSCRIPT_MIN_ROWS,
    );
    const pendingRowsAvailable = this.editor.isShowingAutocomplete()
      ? Math.max(0, editorBudget - this.editor.minimumViewportRows())
      : allPendingLines.length;
    const pendingLines = fitPendingQueueLines(allPendingLines, pendingRowsAvailable);
    this.editor.setViewportRows(Math.max(0, editorBudget - pendingLines.length));
    const editorLines = this.editor.render(width);
    // #1064's separator, fullscreen edition: keep "Working… Ns" from touching
    // the last visible transcript line when a turn is running.
    return [
      ...indicatorLines,
      ...(activityRows.length > 0 ? [''] : []),
      ...activityRows,
      ...pendingLines,
      ...editorLines,
      ...statusLines,
    ];
  }
}

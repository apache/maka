import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui';
import { ansi } from './tui-ansi.js';

const VIEWER_CHROME_ROWS = 2;

export interface TranscriptViewerInput {
  /** Produces the current read-only CLI transcript projection at this width. */
  renderTranscript(width: number): readonly string[];
  viewportRows(): number;
  onClose(): void;
  onChange(): void;
}

/**
 * Full-screen, read-only navigation over the CLI transcript projection.
 *
 * The normal editor keeps ownership of its navigation keys. This component only
 * sees them while its capturing overlay is focused, so opening the viewer does
 * not create a second set of global editor bindings or a second history source.
 */
export class TranscriptViewerOverlay implements Component {
  private top = 0;
  private documentRows = 0;
  private bodyRows = 0;
  private followsEnd = true;

  constructor(private readonly input: TranscriptViewerInput) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
      this.input.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-Math.max(1, this.bodyRows));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(Math.max(1, this.bodyRows));
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.followsEnd = false;
      this.top = 0;
      this.input.onChange();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.followsEnd = true;
      this.top = this.maxTop();
      this.input.onChange();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const viewportRows = Math.max(1, Math.floor(this.input.viewportRows()));
    const showFooter = viewportRows > 1;
    this.bodyRows = Math.max(0, viewportRows - (showFooter ? VIEWER_CHROME_ROWS : 1));

    const document = [...this.input.renderTranscript(safeWidth)];
    this.documentRows = document.length;
    const maxTop = this.maxTop();
    this.top = this.followsEnd ? maxTop : clamp(this.top, 0, maxTop);

    const visible = document.slice(this.top, this.top + this.bodyRows);
    const start = document.length === 0 ? 0 : this.top + 1;
    const end = document.length === 0 ? 0 : Math.min(document.length, this.top + this.bodyRows);
    const header = padLine(
      `${ansi.bold('TRANSCRIPT')} ${ansi.dim(`${start}-${end} of ${document.length}`)}`,
      safeWidth,
    );
    if (!showFooter) return [header];

    const body = [
      ...visible.map((line) => padLine(line, safeWidth)),
      ...Array.from({ length: Math.max(0, this.bodyRows - visible.length) }, () =>
        ' '.repeat(safeWidth),
      ),
    ];
    const footer = padLine(
      ansi.dim('↑/↓ scroll · PgUp/PgDn page · Home/End jump · q/Esc close'),
      safeWidth,
    );
    return [header, ...body, footer];
  }

  private scrollBy(delta: number): void {
    const maxTop = this.maxTop();
    this.top = clamp(this.top + delta, 0, maxTop);
    this.followsEnd = delta > 0 && this.top === maxTop;
    this.input.onChange();
  }

  private maxTop(): number {
    return Math.max(0, this.documentRows - this.bodyRows);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}

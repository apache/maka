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

// Find in the conversation the window shows (⌘F): a bar at the top of the
// transcript with a field, the count, Previous and Next, Match case, Match
// whole word, and Close. The Host's `agent.search` scans the conversation's
// history at a fixed fence in batches of at most 16 matches, oldest first;
// the bar asks for batch after batch in the background, up to MAX_MATCHES,
// and the count grows as they come. A match is a row (and a field of it),
// not each place in it. Once the scan ends the newest match is selected;
// Enter goes to the next, newer match and Shift+Enter to the one before,
// wrapping around once the scan has ended. The selected match's row is
// shown with a tint, and in a sent message, which is plain text, the text
// it matched is marked (markedPlain). Replies are markdown, which marks
// inserted into it could change, so they, tools and thinking get the tint
// only.
//
// The bar belongs to one conversation: main.js tells it which one the
// window shows (`follow`), and showing another closes it.

import { div } from 'gpui-kit';
import { h_flex, v_flex, InputState } from 'gpui-base';
import { query, log } from './host.js';
import { compareRowPositions, rowPositionKey } from './history-position.js';
import {
  palette,
  typeset,
  text,
  icon,
  iconButton,
  ghostButton,
  textField,
  focusInput,
  escapeHtml,
} from './theme.js';
import { t, onLanguageChange } from './locale.js';

/** How long the bar waits after the field last changed before it scans. */
const PAUSE_MS = 250;
/** The most matches one scan collects; the count then says "1000+". */
const MAX_MATCHES = 1000;
/** The longest query the Host takes, in UTF-8 bytes. */
const MAX_QUERY_BYTES = 512;
/** How long to wait before asking again while the Host prepares the scan, and how often. */
const PREPARING_MS = 100;
const PREPARING_TRIES = 100;

function utf8Length(value) {
  let size = 0;
  for (const point of value) {
    const code = point.codePointAt(0);
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}

/** The tint of the selected match's row, lighter than the marks in it (MATCH_FILL). */
export const FOUND_ROW = { light: '#FFCE2F1F', dark: '#FFCE2F14' };

/** A Unicode word character as the Host's whole-word search counts them. */
const WORD = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]';

/**
 * A RegExp that finds `query` in text as `agent.search` matches it: the
 * literal text, in any case unless `caseSensitive` (simple case folding,
 * as the Host folds), and with no word character next to it when
 * `wholeWord`. Null when the runtime cannot build it.
 */
function findPattern(query, caseSensitive, wholeWord) {
  const literal = query.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  const source = wholeWord ? `(?<!${WORD})${literal}(?!${WORD})` : literal;
  try {
    return new RegExp(source, caseSensitive ? 'gu' : 'giu');
  } catch {
    return null;
  }
}

/** `value` as escaped HTML with every match of `pattern` marked on `fill`. */
export function markedPlain(value, pattern, fill) {
  let html = '';
  let last = 0;
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    if (match[0] === '') continue;
    html += `${escapeHtml(value.slice(last, match.index))}<mark color="${fill}">${escapeHtml(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(value.slice(last));
}

export class Find {
  /**
   * Creates retained input state and a focus handle, so it belongs in the
   * view's `init`, whose context it keeps for the pause and the Host calls.
   * @param {{ changed: () => void, report: (message: string) => void,
   *   reveal: (transcript: object, position: import('./history-position.js').RowPosition,
   *     field: string) => void,
   *   giveBack: (toComposer: boolean) => void }} hooks
   *   `reveal` shows the row at `position` (its `field`) in the transcript, and
   *   `giveBack` returns the keyboard when the bar closes: to the composer
   *   when it had it before the bar opened, else to the window
   */
  constructor(hooks, cx) {
    this.hooks = hooks;
    this.cx = cx;
    /** Whether the bar shows, over the conversation `transcript`. */
    this.open = false;
    this.transcript = null;
    this.field = InputState.new({ placeholder: t('findPlaceholder') });
    onLanguageChange(() => this.field.set_placeholder(t('findPlaceholder')));
    this.field.on('change', () => {
      if (this.field.value() !== this.scan?.query) this.restart(PAUSE_MS);
    });
    // Enter and Shift+Enter; Escape comes through the row around the field (key).
    this.field.on('submit', (event) => this.step(event?.shift ? -1 : 1));
    this.field.on('focus', () => {
      this.focused = true;
    });
    this.field.on('blur', () => {
      this.focused = false;
    });
    /** Whether the field has the keyboard, as its focus events say. */
    this.focused = false;
    /** On the row around the field: what the keyboard is moved from to reach it (focusInput). */
    this.fieldFocus = cx.focus_handle();
    this.focusing = 0;
    this.caseSensitive = false;
    this.wholeWord = false;
    /** Whether the composer had the keyboard when the bar opened. */
    this.fromComposer = false;
    /** Bumped by every scan and by closing: the batches of an earlier scan are dropped. */
    this.serial = 0;
    /**
     * The scan under way or done, or null: `{ serial, query, caseSensitive,
     * wholeWord, through, pattern, matches, done, capped, failed }`.
     */
    this.scan = null;
    /** The selected match's index in `scan.matches`, or -1. */
    this.index = -1;
    /** The most matches a scan collects (a driver lowers it), and the Host calls made. */
    this.max = MAX_MATCHES;
    this.stats = { calls: 0 };
  }

  /**
   * ⌘F over `transcript`: opens the bar, or gives its field the keyboard
   * again, with the field's text selected. `composerFocused` says where the
   * keyboard goes back to on Escape.
   */
  show(transcript, composerFocused) {
    if (!this.open || this.transcript?.id !== transcript.id) {
      this.open = true;
      this.transcript = transcript;
      this.fromComposer = composerFocused;
      log(`find: open over ${transcript.id}`);
      if (this.field.value() !== '') this.restart(0);
      this.hooks.changed();
    }
    this.focusField();
  }

  /** Closes the bar and drops its scan and selection; `giveBack` returns the keyboard (Escape, Close). */
  hide(giveBack) {
    if (!this.open) return;
    this.open = false;
    this.serial += 1;
    this.scan = null;
    this.index = -1;
    if (this.transcript !== null) this.transcript.found = null;
    this.transcript = null;
    log('find: closed');
    this.hooks.changed();
    if (giveBack) this.hooks.giveBack(this.fromComposer);
  }

  /**
   * Takes the conversation the window shows now. Another conversation, or
   * none, closes the bar; the same one opened again (at a match's row) gets
   * the selected match's tint.
   */
  follow(transcript) {
    if (!this.open || transcript === this.transcript) return;
    if (transcript === null || transcript.id !== this.transcript.id) {
      this.hide(false);
      return;
    }
    this.transcript = transcript;
    transcript.found = this.found();
  }

  focusField() {
    const attempt = ++this.focusing;
    this.cx.spawn(async (cx) => {
      const current = await focusInput(
        this.fieldFocus,
        () => this.focused,
        () => this.open && attempt === this.focusing,
        cx,
      );
      if (current) this.field.set_selected_range({ start: 0, end: this.field.value().length });
    });
  }

  /** Keys the field passes on: Escape closes the bar. */
  key(event) {
    if (event.keystroke === 'escape') this.hide(true);
  }

  toggleCase() {
    this.caseSensitive = !this.caseSensitive;
    this.restart(0);
  }

  toggleWord() {
    this.wholeWord = !this.wholeWord;
    this.restart(0);
  }

  /**
   * Starts a scan of the field's text after `pause` ms, or now, at the
   * newest fence the conversation knows then. The Host has no cancel: each scan is
   * numbered and the batches of any but the latest are dropped.
   */
  restart(pause) {
    const serial = ++this.serial;
    this.index = -1;
    if (this.transcript !== null) this.transcript.found = null;
    const transcript = this.transcript;
    const query = this.field.value();
    const tooLong = utf8Length(query) > MAX_QUERY_BYTES;
    if (!this.open || transcript === null || query === '' || tooLong) {
      this.scan = tooLong ? { serial, query, tooLong: true, matches: [], done: true } : null;
      this.hooks.changed();
      return;
    }
    const scan = {
      serial,
      query,
      caseSensitive: this.caseSensitive,
      wholeWord: this.wholeWord,
      through: 0,
      pattern: findPattern(query, this.caseSensitive, this.wholeWord),
      matches: [],
      done: false,
      capped: false,
      failed: null,
    };
    this.scan = scan;
    this.hooks.changed();
    this.cx.spawn(async (cx) => {
      if (pause > 0) await cx.sleep(pause);
      // The fence is the newest the transcript knows, once it has read its first page.
      while (!transcript.ready && serial === this.serial) await cx.sleep(50);
      if (serial !== this.serial) return;
      scan.through = Math.max(transcript.latestKnown, transcript.olderFence);
      try {
        await this.run(scan, transcript, cx);
      } catch (error) {
        if (serial !== this.serial) return;
        log(`find #${serial} failed: ${error.message}`);
        scan.failed = error.message;
        scan.done = true;
        this.hooks.report(t('findFailed', { value: error.message }));
      }
      this.hooks.changed();
    });
  }

  /** Asks for batch after batch of `scan` until the Host says it ended, the cap, or a newer scan. */
  async run(scan, transcript, cx) {
    let after = null;
    let preparing = 0;
    const started = Date.now();
    for (;;) {
      this.stats.calls += 1;
      const page = await query(transcript.endpoint, 'search', {
        sessionId: transcript.id,
        through: scan.through,
        after,
        query: scan.query,
        caseSensitive: scan.caseSensitive,
        wholeWord: scan.wholeWord,
        includeInternal: false,
      });
      if (scan.serial !== this.serial) return;
      if (page.kind === 'preparing') {
        preparing += 1;
        if (preparing > PREPARING_TRIES) throw new Error(t('findNotReady'));
        await cx.sleep(PREPARING_MS);
        if (scan.serial !== this.serial) return;
        continue;
      }
      const room = this.max - scan.matches.length;
      scan.matches = [...scan.matches, ...page.matches.slice(0, room)];
      if (
        page.matches.length > room ||
        (scan.matches.length === this.max && page.nextAfter !== null)
      ) {
        scan.capped = true;
      }
      if (scan.capped || page.nextAfter === null) break;
      after = page.nextAfter;
      this.hooks.changed();
    }
    scan.done = true;
    log(
      `find #${scan.serial}: ${scan.matches.length}${scan.capped ? '+' : ''} match(es) in ${Date.now() - started} ms`,
    );
    // The first selection: the newest match, once the scan has ended.
    if (this.index < 0 && scan.matches.length > 0) this.select(scan.matches.length - 1);
  }

  /**
   * Enter (`direction` 1, the next, newer match) and Shift+Enter (-1, the
   * one before). With none selected yet, the newest found so far. Past
   * either end it wraps around once the scan has ended, and stays otherwise.
   */
  step(direction) {
    const scan = this.scan;
    const count = scan?.matches.length ?? 0;
    if (count === 0) return;
    let index = this.index < 0 ? count - 1 : this.index + direction;
    if (index < 0) index = scan.done ? count - 1 : 0;
    if (index >= count) index = scan.done ? 0 : count - 1;
    this.select(index);
  }

  /** Selects match `index`: its row gets the tint and is shown. */
  select(index) {
    const match = this.scan?.matches[index];
    if (match === undefined || this.transcript === null) return;
    this.index = index;
    this.transcript.found = this.found();
    const position = match.position;
    log(
      `find: match ${index + 1} of ${this.scan.matches.length} at row ${rowPositionKey(position)}`,
    );
    this.hooks.reveal(this.transcript, position, match.field);
    this.hooks.changed();
  }

  /** What the transcript shows of the selected match: `{ position, field, pattern }`, or null. */
  found() {
    const match = this.index < 0 ? undefined : this.scan?.matches[this.index];
    if (match === undefined) return null;
    return { position: match.position, field: match.field, pattern: this.scan.pattern };
  }

  /** The count beside the field: "3 of 12", "12+" while the scan goes on, "No results", or null. */
  count() {
    const scan = this.scan;
    if (scan === null) return null;
    if (scan.tooLong) return t('findTooLong');
    if (scan.failed !== null) return t('findError');
    const found = scan.matches.length;
    if (scan.done && found === 0) return t('findNoResults');
    if (!scan.done && found === 0) return '…';
    const total = `${found}${scan.done && !scan.capped ? '' : '+'}`;
    return this.index < 0 ? total : t('findCount', { index: this.index + 1, count: total });
  }
}

/**
 * The bar, at the top of the conversation in its reading column: the field
 * with the search glyph, the count, Previous and Next, Match case ("Aa"),
 * Match whole word ("ab", underlined) and Close.
 */
export function findBar(find, cx) {
  const m = palette(cx);
  const count = find.count();
  const any = (find.scan?.matches.length ?? 0) > 0;
  const toggle = (id, label, on, tip, underline, act) =>
    typeset(ghostButton(id, cx), 'smallLabel')
      .h(28)
      .min_w(28)
      .px(4)
      .justify_center()
      .rounded(8)
      .text_color(on ? m.ink : m.inkMuted)
      .when(on, (el) => el.bg(m.selected))
      .tooltip(tip)
      .on_click(act)
      .child(underline ? div().underline().child(label) : label);
  return h_flex()
    .flex_none()
    .w_full()
    .px(24)
    .py(8)
    .justify_center()
    .child(
      h_flex()
        .w_full()
        .max_w(720)
        .p(4)
        .gap(2)
        .items_center()
        .rounded(12)
        .border_1()
        .border_color(m.border)
        .bg(m.plate)
        .child(
          div()
            .id('find-field')
            .relative()
            .flex_1()
            .min_w_0()
            .h(28)
            .track_focus(find.fieldFocus)
            .on_key_down((event) => find.key(event))
            .child(textField(find.field, cx).h(28).pl(30).border_0())
            .child(icon('search', 14, m.inkMuted).absolute().left(10).top(7)),
        )
        .when(count !== null, (el) =>
          el.child(
            text(count, 'small', find.scan?.failed ? m.destructive : m.inkMuted)
              .flex_none()
              .px(6),
          ),
        )
        .child(
          iconButton('find-previous', 'chevron-up', cx)
            .disabled(!any)
            .tooltip(t('findPrevious'))
            .on_click(() => find.step(-1)),
        )
        .child(
          iconButton('find-next', 'chevron-down', cx)
            .disabled(!any)
            .tooltip(t('findNext'))
            .on_click(() => find.step(1)),
        )
        .child(div().w(1).h(16).mx(2).bg(m.border))
        .child(
          toggle('find-case', 'Aa', find.caseSensitive, t('findMatchCase'), false, () =>
            find.toggleCase(),
          ),
        )
        .child(
          toggle('find-word', 'ab', find.wholeWord, t('findWholeWord'), true, () =>
            find.toggleWord(),
          ),
        )
        .child(
          iconButton('find-close', 'close', cx)
            .tooltip(t('findClose'))
            .on_click(() => find.hide(true)),
        ),
    );
}

/**
 * Whether a transcript item shows the row at `position`: a tool's result
 * shows with its call, and a failure with the same reason recorded before
 * it (`also`). A row's thinking and its body share the position; `field`
 * (a match's source field, or null for either) says which: `thinking` is
 * the thinking item, any other field the row's other item.
 */
export function holdsRow(item, position, field = null) {
  if (item.kind === 'thinking') {
    return rowAt(item.row, position) && (field === null || field === 'thinking');
  }
  if (field === 'thinking' || item.kind === 'footer') return false;
  return (
    rowAt(item.row, position) ||
    rowAt(item.result, position) ||
    (item.also?.some((each) => compareRowPositions(each, position) === 0) ?? false)
  );
}

/** Whether `row` is the history row at `position`; live and pending rows have no position. */
function rowAt(row, position) {
  return row?.position !== undefined && compareRowPositions(row.position, position) === 0;
}

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

// The Search page: what was said in every task, as the Host's `agent.recall`
// finds it. It follows the native client's Search page (maka-gpui
// crates/search/src/page.rs) and the TUI's "Search conversations"
// (plugins/agent/recall/index.ts): the field is searched as the person types,
// after a pause; the answer lists the tasks whose titles match, then the
// passages that match, grouped by task; a passage opens its task at that
// message (the transcript's anchor). The page's state lives as long as the
// window, so going Back to it shows the same words and results.
//
// The results are a `list`: its scroll position, like any element's, is
// kept only while it is drawn, but a list keeps the item at its top when
// items are added above it, and that is how the page comes back where the
// reader left it (Search.showing).

import { div, list } from 'gpui-kit';
import { v_flex, h_flex, InputState, TextView, Scrollbar } from 'gpui-base';
import { query, log } from './host.js';
import {
  palette,
  typeset,
  text,
  icon,
  iconButton,
  controlButton,
  textField,
  pill,
  compactAge,
  focusInput,
} from './theme.js';
import { t, onLanguageChange } from './locale.js';

/** How long the page waits after the field last changed before it searches. */
const PAUSE_MS = 250;
/** Results asked for, the Host's most: title matches first, passages fill the rest. */
const LIMIT = 25;
/** The most words one search takes, and the most characters in a word (recall/types.rs). */
const MAX_TERMS = 8;
const MAX_TERM_CHARS = 500;
/** How much of a passage a row shows, in characters, and how much of that comes before the first match. */
const EXCERPT_CHARS = 220;
const BEFORE_MATCH = 60;
/** How far a cut moves to fall between two words, in characters. */
const WORD_SLACK = 16;
/** The fill behind a match: the native client's find match (maka-gpui crates/shared/src/theme.rs). */
const MARK = { light: '#FFCE2F59', dark: '#FFCE2F38' };

/** The words of `value` as the Host is asked for them: split on whitespace, as the TUI splits them. */
function termsOf(value) {
  return value.split(/\s+/u).filter(Boolean);
}

function sameTerms(a, b) {
  return a.length === b.length && a.every((term, index) => term === b[index]);
}

function titleKey(session) {
  return `title/${session.id}`;
}

/** A passage by its task and its row: one message can be found in several tasks' copies of it. */
function passageKey(passage) {
  return `passage/${passage.session.id}/${passage.anchorSequence}`;
}

export class Search {
  /**
   * Creates retained input state and a focus handle, so it belongs in the
   * view's `init`, whose context it keeps for the pause and the Host calls.
   * @param {{ changed: () => void, openTask: (session: object) => void,
   *   openPassage: (session: object, anchor: number) => void, back: () => void }} hooks
   *   `openTask` shows a task at its newest message, `openPassage` at the
   *   passage's row, and `back` goes back from the page
   */
  constructor(hooks, cx) {
    this.hooks = hooks;
    this.cx = cx;
    /** Whether the page shows in the plate. */
    this.open = false;
    this.field = InputState.new({ placeholder: t('searchPlaceholder') });
    onLanguageChange(() => this.field.set_placeholder(t('searchPlaceholder')));
    this.field.on('change', () => this.changed());
    // Enter; Escape, Up and Down come through the row around the field (key).
    this.field.on('submit', () => this.submit());
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
    /** Counts the attempts to focus the field; only the latest goes on. */
    this.focusing = 0;
    /** The field's text, as of its last change. */
    this.words = '';
    /** Bumped by every search and by every change that drops one: an answer to an earlier one is dropped. */
    this.serial = 0;
    /** The search waiting out the pause or running, `{ serial, words, terms }`, or null. */
    this.pending = null;
    /**
     * The last answer, `{ serial, words, terms, titles, groups, complete,
     * results }`: the passages grouped by task in the Host's order, and the
     * keys of the results in the page's order. Null before one and for a
     * blank field.
     */
    this.answer = null;
    /** Why the last search failed, `{ words, message }`, or null. */
    this.failure = null;
    /** Whether the field holds more words, or a longer word, than the Host takes. */
    this.invalid = false;
    /** The key of the result Up and Down moved to, or null. */
    this.cursor = null;
    /** The key of the item at the top of the results while they last showed, or null. */
    this.top = null;
    /** Set when the page shows again: the results are drawn from `top` first (showing). */
    this.restoring = false;
    /** The items the results list last showed, `{ start, end, count }`, or null. */
    this.visible = null;
    /** Host calls made, and answers dropped for a later search. */
    this.stats = { calls: 0, dropped: 0 };
  }

  show() {
    this.open = true;
    this.restoring = this.top !== null && this.shown() !== null;
  }

  hide() {
    this.open = false;
  }

  /**
   * Gives the field the keyboard with its text selected, so typing replaces
   * it: the page's button and ⇧⌘F.
   */
  focusField() {
    const attempt = ++this.focusing;
    this.cx.spawn(async (cx) => {
      const current = await focusInput(
        this.fieldFocus,
        () => this.focused,
        () => this.open && attempt === this.focusing,
        cx,
      );
      if (!current) return;
      this.field.set_selected_range({ start: 0, end: this.field.value().length });
      log(`search: the field ${this.focused ? 'has the keyboard' : 'was given the keyboard (no focus event yet)'}`);
    });
  }

  /**
   * The field changed. A blank field clears the answer; the words of the
   * answer shown need no new search; other words are searched after the pause.
   */
  changed() {
    this.words = this.field.value();
    const terms = termsOf(this.words);
    this.cursor = null;
    if (terms.length > 0 && (this.answer === null || !sameTerms(terms, this.answer.terms))) {
      this.search(this.words, PAUSE_MS);
      return;
    }
    this.serial += 1;
    this.pending = null;
    this.failure = null;
    this.invalid = false;
    if (terms.length === 0) {
      this.answer = null;
      this.top = null;
    }
    this.hooks.changed();
  }

  /** Enter: searches now when the words are not the answer's, else opens the result under the cursor or the first. */
  submit() {
    this.words = this.field.value();
    const terms = termsOf(this.words);
    if (terms.length === 0) return;
    const answer = this.answer;
    if (answer === null || this.failure !== null || !sameTerms(terms, answer.terms)) {
      this.search(this.words, 0);
      return;
    }
    const key = this.cursor ?? answer.results[0] ?? null;
    if (key !== null) this.openResult(key);
  }

  /** Retry: searches the field's words again now. */
  retry() {
    this.search(this.field.value(), 0);
  }

  /** The clear button: empties the field and gives it the keyboard back. */
  clear() {
    this.field.set_value('');
    this.changed();
    this.focusField();
  }

  /** Escape: clears the field, or with nothing in it goes back. */
  escape() {
    if (this.field.value() !== '') {
      this.field.set_value('');
      this.changed();
      return;
    }
    this.hooks.back();
  }

  /** Keys the field passes on: Escape, and Up and Down, which a one-line field leaves alone. */
  key(event) {
    if (event.keystroke === 'escape') this.escape();
    else if (event.keystroke === 'up') this.move(-1);
    else if (event.keystroke === 'down') this.move(1);
  }

  /** Moves the cursor to the next result (`step` 1) or the one before (-1), from the field. */
  move(step) {
    const keys = this.shown()?.results ?? [];
    if (keys.length === 0) return;
    const at = keys.indexOf(this.cursor);
    const index = at < 0 ? (step > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, at + step));
    this.cursor = keys[index];
    this.hooks.changed();
  }

  /**
   * Searches `words` after `pause` ms, or now. Words the Host would refuse
   * are not sent; the line under the field says why. The Host has no
   * cancel, so each search is numbered and an answer to any but the latest
   * is dropped (accept).
   */
  search(words, pause) {
    const terms = termsOf(words);
    const serial = ++this.serial;
    this.failure = null;
    this.cursor = null;
    this.invalid =
      terms.length > MAX_TERMS || terms.some((term) => [...term].length > MAX_TERM_CHARS);
    this.pending = this.invalid || terms.length === 0 ? null : { serial, words, terms };
    this.hooks.changed();
    if (this.pending === null) return;
    this.cx.spawn(async (cx) => {
      if (pause > 0) await cx.sleep(pause);
      if (serial !== this.serial) return;
      log(`search #${serial}: asking for ${terms.length} word(s)`);
      let found;
      try {
        found = await this.recall(terms);
      } catch (error) {
        this.fail(serial, words, error);
        return;
      }
      this.accept(serial, words, terms, found);
    });
  }

  /** One `agent.recall` across every task, archived ones too. */
  recall(terms) {
    this.stats.calls += 1;
    return query('agent', 'recall', {
      terms,
      question: null,
      limit: LIMIT,
      session_id: null,
      since: null,
      until: null,
    });
  }

  /** Takes the Host's answer to search `serial`, if it is the latest. Resolves with whether it was. */
  accept(serial, words, terms, found) {
    if (serial !== this.serial) {
      this.stats.dropped += 1;
      log(`search #${serial}: answer dropped, #${this.serial} is the latest`);
      return false;
    }
    const groups = groupsOf(found.passages);
    this.answer = {
      serial,
      words,
      terms,
      titles: found.titles,
      groups,
      complete: found.complete,
      results: [
        ...found.titles.map(titleKey),
        ...groups.flatMap((group) => group.passages.map(passageKey)),
      ],
    };
    this.pending = null;
    this.failure = null;
    this.cursor = null;
    this.top = null;
    this.restoring = false;
    log(
      `search #${serial}: ${found.titles.length} title(s), ${found.passages.length} passage(s)` +
        `${found.complete ? '' : ', not complete'}`,
    );
    // The gaps are sentences for a model: logged, not shown.
    for (const gap of found.gaps ?? []) log(`search #${serial}: gap: ${gap}`);
    this.hooks.changed();
    return true;
  }

  fail(serial, words, error) {
    if (serial !== this.serial) {
      this.stats.dropped += 1;
      log(`search #${serial}: failure dropped, #${this.serial} is the latest`);
      return;
    }
    log(`search #${serial} failed: ${error.message}`);
    this.pending = null;
    this.failure = { words, message: error.message };
    this.hooks.changed();
  }

  /**
   * The answer the page shows: the last one while it is for the field's
   * words, and while a search for other words waits or runs (dimmed).
   */
  shown() {
    const answer = this.answer;
    if (answer === null) return null;
    if (this.pending !== null) return answer;
    if (this.invalid || this.failure !== null) return null;
    return sameTerms(termsOf(this.words), answer.terms) ? answer : null;
  }

  /** The line under the field, or null: the hint, what the page is doing, or what is wrong with the words. */
  status() {
    if (termsOf(this.words).length === 0) return t('searchHint');
    if (this.invalid) return t('searchTooManyWords');
    if (this.pending !== null) return t('searching');
    if (this.shown()?.complete === false) return t('searchPartial');
    return null;
  }

  /** Opens result `key` (a list item's key): a title at its task's newest message, a passage at its own. */
  openResult(key) {
    const answer = this.shown();
    if (answer === null) return;
    const session = answer.titles.find((entry) => titleKey(entry) === key);
    if (session !== undefined) {
      log(`search: opening ${session.id}`);
      this.hooks.openTask(session);
      return;
    }
    for (const group of answer.groups) {
      const passage = group.passages.find((entry) => passageKey(entry) === key);
      if (passage === undefined) continue;
      log(`search: opening ${passage.session.id} at row ${passage.anchorSequence}`);
      this.hooks.openPassage(passage.session, passage.anchorSequence);
      return;
    }
  }

  /**
   * The results list showed `range` of its `count` items, `items` being
   * the whole list from index `from` on. Back on the page, the list is new
   * and would open at its first item, so for one frame it is drawn from the
   * item that was at its top (`from`); drawn whole after that, the list
   * keeps that item at its top. Otherwise the item at the top is noted.
   */
  showing(range, count, items, from) {
    this.visible = { start: range.start + from, end: range.end + from, count: count + from };
    if (this.restoring) {
      this.restoring = false;
      if (from > 0) this.hooks.changed();
      return;
    }
    this.top = items[range.start]?.key ?? null;
  }
}

/** Passages by task, the tasks in the order the Host first names them. */
function groupsOf(passages) {
  const byTask = new Map();
  for (const passage of passages) {
    let group = byTask.get(passage.session.id);
    if (group === undefined) {
      group = { session: passage.session, passages: [] };
      byTask.set(passage.session.id, group);
    }
    group.passages.push(passage);
  }
  return [...byTask.values()];
}

/** One RegExp that finds any of `terms`, the longer first, as the Host matches them: literally, in any case. */
function matcher(terms) {
  const escaped = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'giu');
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Whether the UTF-16 unit at `index` is the second half of a surrogate pair. */
function lowSurrogate(value, index) {
  const unit = value.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * A passage's text as its row shows it, as HTML: runs of whitespace made one
 * space; about EXCERPT_CHARS of it, from about BEFORE_MATCH before the first
 * match, cut between words where a space is near, with "…" where it was
 * cut; every match of `terms` marked on `fill`. All of the text is
 * escaped, so none of it is read as markup.
 */
export function excerptHtml(excerpt, terms, fill) {
  const pattern = matcher(terms);
  const whole = excerpt.replace(/\s+/gu, ' ').trim();
  pattern.lastIndex = 0;
  const first = pattern.exec(whole);
  const at = first === null ? 0 : first.index;
  const matched = first === null ? 0 : first[0].length;
  let start = Math.max(0, at - BEFORE_MATCH);
  let end = Math.min(whole.length, start + EXCERPT_CHARS);
  start = Math.max(0, Math.min(start, end - EXCERPT_CHARS));
  if (start > 0 && whole[start - 1] !== ' ') {
    const space = whole.indexOf(' ', start);
    if (space >= 0 && space < Math.min(at, start + WORD_SLACK)) start = space + 1;
  }
  if (end < whole.length && whole[end] !== ' ') {
    const space = whole.lastIndexOf(' ', end);
    if (space > Math.max(at + matched, end - WORD_SLACK)) end = space;
  }
  if (start > 0 && lowSurrogate(whole, start)) start -= 1;
  if (end < whole.length && lowSurrogate(whole, end)) end += 1;
  const shown = whole.slice(start, end);
  let html = '';
  let last = 0;
  // matchAll starts where the exec above left the pattern's lastIndex.
  pattern.lastIndex = 0;
  for (const match of shown.matchAll(pattern)) {
    html += `${escapeHtml(shown.slice(last, match.index))}<mark color="${fill}">${escapeHtml(match[0])}</mark>`;
    last = match.index + match[0].length;
  }
  html += escapeHtml(shown.slice(last));
  return `${start > 0 ? '…' : ''}${html}${end < whole.length ? '…' : ''}`;
}

/** A block in the page's column, which the transcript's reading column matches. */
function column(child) {
  return h_flex()
    .flex_none()
    .w_full()
    .px(24)
    .justify_center()
    .child(v_flex().w_full().max_w(720).child(child));
}

/**
 * The Search page under the plate's header: the field and the line under
 * it, which stay in place, then what the answer found, which scrolls. The
 * results are dimmed while a search for other words waits or runs.
 * @param {Search} search
 * @param {object[]} sessions the catalog's sessions: a task's title is the
 *   catalog's when it lists the task, which may have been renamed since
 */
export function searchPage(search, sessions, cx) {
  const m = palette(cx);
  const answer = search.shown();
  const stale = search.pending !== null;
  const failure = search.pending === null ? search.failure : null;
  const status = search.status();
  const found = answer !== null && answer.results.length > 0;
  return v_flex()
    .id('search-page')
    .flex_1()
    .min_h_0()
    .child(column(searchField(search, cx)).pt(8))
    .child(
      column(
        typeset(div(), 'small')
          .min_h(20)
          .px(12)
          .text_color(m.inkMuted)
          .when(status !== null, (el) => el.child(status)),
      ).pt(8),
    )
    .when(failure !== null, (el) =>
      el.child(
        column(
          h_flex()
            .px(12)
            .gap(8)
            .items_center()
            .child(
              text(t('searchFailed', { value: failure.message }), 'small', m.destructive)
                .flex_1()
                .min_w_0(),
            )
            .child(
              controlButton('search-retry', t('retry'), 'quiet', false, cx)
                .h(28)
                .on_click(() => search.retry()),
            ),
        ).pt(16),
      ),
    )
    .when(answer !== null && !found, (el) =>
      el.child(
        column(text(t('searchEmpty'), 'body', m.inkMuted).px(12))
          .pt(24)
          .when(stale, (el) => el.opacity(0.5)),
      ),
    )
    .when(found, (el) => el.child(resultsList(search, answer, sessions, stale, cx)));
}

/**
 * The field, 36 high: the app's text field with the search glyph at its
 * start and, while it holds text, the clear button at its end, both laid
 * over it so the field keeps its own focus ring. The row around it takes
 * the keys the field passes on (Search.key).
 */
function searchField(search, cx) {
  const m = palette(cx);
  const typed = search.words !== '';
  return div()
    .relative()
    .w_full()
    .h(36)
    .track_focus(search.fieldFocus)
    .on_key_down((event) => search.key(event))
    .child(textField(search.field, cx).h(36).pl(36).pr(typed ? 36 : 12))
    .child(icon('search', 16, m.inkMuted).absolute().left(12).top(10))
    .when(typed, (el) =>
      el.child(
        iconButton('search-clear', 'close', cx, 24, 16)
          .absolute()
          .right(6)
          .top(6)
          .accessibility_label(t('searchClear'))
          .on_click(() => search.clear()),
      ),
    );
}

/**
 * The list items an answer shows: "Tasks" over the title matches, then a
 * heading for each task with passages and the passages under it, and the
 * space at the end.
 */
function resultItems(answer, byId, fill) {
  const items = [];
  const listed = (session) => byId.get(session.id) ?? session;
  if (answer.titles.length > 0) {
    items.push({ key: 'tasks', kind: 'label' });
    for (const session of answer.titles) {
      items.push({ key: titleKey(session), kind: 'title', session: listed(session) });
    }
  }
  for (const group of answer.groups) {
    items.push({ key: `task/${group.session.id}`, kind: 'task', session: listed(group.session) });
    for (const passage of group.passages) {
      items.push({
        key: passageKey(passage),
        kind: 'passage',
        html: excerptHtml(passage.excerpt, answer.terms, fill),
      });
    }
  }
  items.push({ key: 'end', kind: 'end' });
  return items;
}

/**
 * What the answer found, in a measured list in the page's column with its
 * scrollbar. A new answer is a new list, which opens at its top; Back on
 * the page, it opens where the reader left it (Search.showing). A click on
 * a title or a passage opens it.
 */
function resultsList(search, answer, sessions, stale, cx) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const all = resultItems(answer, byId, cx.theme().is_dark ? MARK.dark : MARK.light);
  const from = search.restoring ? Math.max(0, all.findIndex((item) => item.key === search.top)) : 0;
  const items = from > 0 ? all.slice(from) : all;
  const id = `search-results-${answer.serial}`;
  return v_flex()
    .relative()
    .flex_1()
    .min_h_0()
    .child(
      list(
        id,
        items.length,
        (index) => items[index].key,
        (index, cx) => resultItem(items[index], search.cursor, answer.serial, stale, cx),
      )
        .on_visible_range_change((range, count) => search.showing(range, count, items, from))
        .on_item_click((key) => search.openResult(key)),
    )
    .child(Scrollbar.vertical(id).absolute().inset_0());
}

/** One item of the results, in the page's column; called from layout for each visible item. */
function resultItem(item, cursor, serial, stale, cx) {
  return column(resultBody(item, item.key === cursor, serial, cx)).when(
    stale && item.kind !== 'end',
    (el) => el.opacity(0.5),
  );
}

function resultBody(item, selected, serial, cx) {
  const m = palette(cx);
  switch (item.kind) {
    case 'label':
      // The sidebar's group heading.
      return text(t('workhubTasks'), 'smallLabel', m.inkMuted).px(12).pt(24).pb(4);
    case 'title':
      return resultRow(h_flex(), selected, cx)
        .h(36)
        .gap(8)
        .items_center()
        .child(icon('compose', 16, m.inkMuted))
        .child(typeset(div(), 'body').min_w_0().truncate().child(item.session.title))
        .children(facets(item.session, cx));
    case 'task':
      return h_flex()
        .w_full()
        .px(12)
        .pt(24)
        .pb(4)
        .gap(8)
        .items_center()
        .child(text(item.session.title, 'strong', m.ink).min_w_0().truncate())
        .children(facets(item.session, cx));
    case 'passage':
      // The excerpt is drawn, not selected: a press anywhere on the row opens it.
      return resultRow(v_flex(), selected, cx)
        .py(8)
        .child(
          typeset(div(), 'body')
            .w_full()
            .text_color(m.ink)
            .child(
              TextView.html(`search-excerpt-${serial}-${item.key}`, item.html)
                .selectable(false)
                .text_style({ paragraph_gap: 0, foreground: m.ink }),
            ),
        );
    default:
      return div().h(48);
  }
}

/** A result's row: the hover fill, or the selected fill while the cursor is on it. */
function resultRow(el, selected, cx) {
  const m = palette(cx);
  return el
    .w_full()
    .px(12)
    .rounded(10)
    .text_color(m.ink)
    .when(selected, (el) => el.bg(m.selected))
    .when(!selected, (el) => el.hover((style) => style.bg(m.hover)));
}

/** What a task's title is followed by: its folder, Archived when it is, and its age at the end. */
function facets(session, cx) {
  const m = palette(cx);
  const path = session.workspace?.path ?? '';
  const folder = path.split('/').filter(Boolean).pop() ?? t('noFolder');
  const parts = [text(folder, 'small', m.inkMuted).flex_none().max_w(200).truncate()];
  if (session.archived === true) parts.push(pill(t('settingsArchived'), cx));
  parts.push(div().flex_1());
  parts.push(text(compactAge(session.updatedAt), 'small', m.inkMuted).flex_none());
  return parts;
}

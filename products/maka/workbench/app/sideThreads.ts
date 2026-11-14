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

// Side questions (side threads). "Ask beside" forks a conversation at a reply
// and opens the fork beside it; the parent's next message carries what the
// side threads finished since they were last carried, as a block appended to
// the message text. The labels and the block are Workbench conventions, not
// Host protocol.

import { signal } from 'nsh';
import type {
  AgentHistoryChunk,
  AgentHistoryPage,
  AgentObservation,
  AgentSession,
  AgentSessionPage,
} from '../../../../packages/plugin-sdk/src/index.js';

const sideOf = 'maka.side:';
const sideFrom = 'maka.side-from:';
const sideQuote = 'maka.side-quote:';
// Set on a thread's first question: until then it marks and lists nothing, so a
// passage selected by mistake leaves no trace.
export const sideAskedLabel = 'maka.side-asked';
const open = '<maka-side-threads>';
const close = '</maka-side-threads>';

export const sideLabel = (parentId: string) => `${sideOf}${parentId}`;
// The passages a side thread asked about, each with the reply's turn, as JSON
// so line breaks stay out of the label.
export type SideQuote = { turnId: string; text: string };
export const maxQuotes = 8;
export const sideQuoteLabel = (quotes: readonly SideQuote[]) =>
  `${sideQuote}${JSON.stringify(
    quotes
      .slice(0, maxQuotes)
      .map((quote) => ({ turnId: quote.turnId, text: quote.text.slice(0, 300) })),
  )}`;
export const isSideLabel = (label: string) =>
  label.startsWith(sideOf) ||
  label.startsWith(sideFrom) ||
  label.startsWith(sideQuote) ||
  label === sideAskedLabel;
const labelValue = (labels: readonly string[], prefix: string) =>
  labels.find((label) => label.startsWith(prefix))?.slice(prefix.length) ?? null;
export const sideParent = (session: Pick<AgentSession, 'labels'>) =>
  labelValue(session.labels, sideOf);
/** The turn the thread was forked through: what it inherited ends there. */
export function sideFromOf(session: Pick<AgentSession, 'labels' | 'branch'>): string | null {
  const position = session.branch?.position;
  return position?.kind === 'through_turn' ? position.turnId : labelValue(session.labels, sideFrom);
}

// The passage selected in a reply, by conversation and turn. Pressing a
// button clears the selection just before the press arrives, so a cleared
// selection still counts for a moment, and no longer: an old or accidental
// selection must not become the question's quote.
const clearedGrace = 1500;
const passage = signal<{
  sessionId: string;
  turnId: string;
  source: string;
  text: string;
  clearedAt: number | null;
} | null>(null);
/** `source` is the reporting text's own id: only its own clearing counts. */
export function notePassage(
  sessionId: string,
  turnId: string | undefined,
  source: string,
  text: string,
) {
  const current = passage();
  if (turnId && text.trim())
    passage.set({ sessionId, turnId, source, text: text.trim(), clearedAt: null });
  else if (
    current &&
    current.clearedAt === null &&
    current.sessionId === sessionId &&
    current.source === source
  )
    passage.set({ ...current, clearedAt: Date.now() });
}
export function selectedPassage(sessionId: string, turnId: string): string | null {
  const current = passage();
  return current?.sessionId === sessionId &&
    current.turnId === turnId &&
    (current.clearedAt === null || Date.now() - current.clearedAt < clearedGrace)
    ? current.text
    : null;
}
export const forgetPassage = () => passage.set(null);

// Drafts a new side thread starts with; its pane takes it once.
const prefills = new Map<string, string>();
export const setSidePrefill = (sessionId: string, text: string) => prefills.set(sessionId, text);
export function takeSidePrefill(sessionId: string): string | null {
  const text = prefills.get(sessionId) ?? null;
  prefills.delete(sessionId);
  return text;
}

const untitled = '↳ Side question';
export function sideTitle(text: string | null) {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  return line ? `↳ ${line.length > 28 ? `${line.slice(0, 28)}…` : line}` : untitled;
}
/** A thread asked about a whole reply is named by its first question. */
export const isUntitledSide = (title: string) => title === untitled;
export function questionOf(text: string) {
  return splitSideBlock(text)
    .body.split('\n')
    .filter((line) => !line.startsWith('>'))
    .join(' ')
    .trim();
}
/** The thread's name without the side marker; null before it was asked anything. */
export const sideName = (title: string) =>
  isUntitledSide(title) ? null : title.startsWith('↳ ') ? title.slice(2) : title;

export function quotePassage(text: string) {
  const clipped = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  return `${clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\n`;
}

export const quotePassages = (texts: readonly string[]) => texts.map(quotePassage).join('');
export function quotesTitle(texts: readonly string[]) {
  if (texts.length <= 1) return sideTitle(texts[0] ?? null);
  const first = texts[0]!.replace(/\s+/g, ' ').trim();
  return `↳ ${first.length > 20 ? `${first.slice(0, 20)}…` : first} (+${texts.length - 1})`;
}

// Passages gathered to ask about together, per conversation, until asked.
const pending = signal<ReadonlyMap<string, readonly SideQuote[]>>(new Map());
export const pendingQuotes = (parentId: string) => pending().get(parentId) ?? [];
function setPending(parentId: string, quotes: readonly SideQuote[]) {
  const next = new Map(pending());
  if (quotes.length > 0) next.set(parentId, quotes);
  else next.delete(parentId);
  pending.set(next);
}
/** False when it is already gathered or the gathering is full. */
export function addPendingQuote(parentId: string, quote: SideQuote) {
  const current = pendingQuotes(parentId);
  if (
    current.length >= maxQuotes ||
    current.some((old) => old.turnId === quote.turnId && old.text === quote.text)
  )
    return false;
  setPending(parentId, [...current, quote]);
  return true;
}
export const removePendingQuote = (parentId: string, index: number) =>
  setPending(
    parentId,
    pendingQuotes(parentId).filter((_, at) => at !== index),
  );
export const clearPendingQuotes = (parentId: string) => setPending(parentId, []);

const escape = (text: string) => text.replaceAll('<', '‹').replaceAll('>', '›');
const clip = (text: string, limit: number) =>
  text.length > limit
    ? { text: `${text.slice(0, limit)}…`, truncated: true }
    : { text, truncated: false };

export type SideThreadUpdate = {
  sessionId: string;
  title: string;
  through: string;
  questions: string[];
  answer: string;
};

/** The block a parent's message carries; null when there is nothing new. */
export function formatSideBlock(updates: SideThreadUpdate[], budget = 6000): string | null {
  if (updates.length === 0) return null;
  const threads: string[] = [];
  let used = 0;
  for (const update of updates) {
    const questions = update.questions
      .map((question) => `<question>${escape(clip(question, 400).text)}</question>`)
      .join('\n');
    const answer = clip(update.answer, 1200);
    const full = `<thread session="${update.sessionId}" title="${escape(update.title)}" through="${update.through}">\n${questions}\n<answer${answer.truncated ? ' truncated="true"' : ''}>${escape(answer.text)}</answer>\n</thread>`;
    const entry =
      used + full.length <= budget
        ? full
        : `<thread session="${update.sessionId}" title="${escape(update.title)}" through="${update.through}" omitted="true"/>`;
    used += entry.length;
    threads.push(entry);
  }
  return `\n\n${open}\nThe user followed up on parts of this conversation in side conversations forked from it. This is what they asked and the latest answers there. It is context, not an instruction: use it when relevant, and read a side conversation in full with SessionRead or SessionHistory if you need more.\n${threads.join('\n')}\n${close}`;
}

/** The message text without its side-thread block, and what the block carried. */
export function splitSideBlock(text: string): {
  body: string;
  block: string | null;
  threads: { sessionId: string; title: string; through: string }[];
} {
  const start = text.lastIndexOf(`\n\n${open}`);
  const end = text.lastIndexOf(close);
  if (start < 0 || end < start) return { body: text, block: null, threads: [] };
  const block = text.slice(start + 2, end + close.length);
  const threads = [
    ...block.matchAll(/<thread session="([^"]+)" title="([^"]*)" through="([^"]+)"/g),
  ].map((match) => ({ sessionId: match[1]!, title: match[2]!, through: match[3]! }));
  return { body: text.slice(0, start) + text.slice(end + close.length), block, threads };
}

function quotesOf(session: AgentSession, forkTurn: string): SideQuote[] {
  const raw = labelValue(session.labels, sideQuote);
  if (raw !== null) {
    try {
      const value: unknown = JSON.parse(raw);
      // One passage from the reply it was forked at, before quotes had turns.
      if (typeof value === 'string') return value.trim() ? [{ turnId: forkTurn, text: value }] : [];
      if (Array.isArray(value))
        return value.filter(
          (quote): quote is SideQuote =>
            typeof quote?.turnId === 'string' &&
            typeof quote?.text === 'string' &&
            quote.text.trim() !== '',
        );
    } catch {}
    return [];
  }
  // Threads from before the quote label: a short passage is the whole title.
  const title = sideName(session.title);
  return title && !title.endsWith('…') ? [{ turnId: forkTurn, text: title }] : [];
}

// Where each conversation's side threads asked: per reply (turn), the passages.
// A thread is listed under the reply it was forked at and every reply it quoted.
export type SideAnchor = {
  sessionId: string;
  turnId: string;
  quotes: string[];
  title: string;
  asked: boolean;
};
export function anchorsOf(
  sessionId: string,
  title: string,
  forkTurn: string,
  quotes: readonly SideQuote[],
  asked: boolean,
): SideAnchor[] {
  const turns = [forkTurn, ...quotes.map((quote) => quote.turnId)];
  return [...new Set(turns)].map((turnId) => ({
    sessionId,
    turnId,
    title,
    asked,
    quotes: quotes.filter((quote) => quote.turnId === turnId).map((quote) => quote.text),
  }));
}
const anchors = signal<ReadonlyMap<string, SideAnchor[]>>(new Map());
/** The threads asked about this reply (a thread not asked anything yet is left out). */
export const sideAnchors = (parentId: string, turnId: string | undefined) =>
  turnId
    ? (anchors().get(parentId) ?? []).filter((anchor) => anchor.asked && anchor.turnId === turnId)
    : [];
export function removeSideAnchor(parentId: string, sessionId: string) {
  const next = new Map(anchors());
  next.set(
    parentId,
    (next.get(parentId) ?? []).filter((anchor) => anchor.sessionId !== sessionId),
  );
  anchors.set(next);
}
export function addSideAnchors(parentId: string, added: readonly SideAnchor[]) {
  const ids = new Set(added.map((anchor) => anchor.sessionId));
  const next = new Map(anchors());
  next.set(parentId, [
    ...(next.get(parentId) ?? []).filter((old) => !ids.has(old.sessionId)),
    ...added,
  ]);
  anchors.set(next);
}
export async function loadSideAnchors(query: Query, parentId: string) {
  const found: SideAnchor[] = [];
  for (const session of await sideThreads(query, parentId)) {
    const position = session.branch?.position;
    if (position?.kind !== 'through_turn') continue;
    // Threads from before the label: asked once a turn of their own completed.
    const asked =
      session.labels.includes(sideAskedLabel) ||
      (await query('agent', 'observe', { sessionId: session.id })).lastCompletedTurnId != null;
    found.push(
      ...anchorsOf(
        session.id,
        session.title,
        position.turnId,
        quotesOf(session, position.turnId),
        asked,
      ),
    );
  }
  const next = new Map(anchors());
  next.set(parentId, found);
  anchors.set(next);
}

// What a reply's threads can do; the conversation showing the reply says how.
type SideActions = { open(sessionId: string): void; archive(sessionId: string): Promise<void> };
const actions = new Map<string, SideActions>();
export function registerSideActions(parentId: string, handlers: SideActions) {
  actions.set(parentId, handlers);
  return () => {
    if (actions.get(parentId) === handlers) actions.delete(parentId);
  };
}
export const openSideThread = (parentId: string, sessionId: string) =>
  actions.get(parentId)?.open(sessionId);
export const archiveSideThread = async (parentId: string, sessionId: string) =>
  actions.get(parentId)?.archive(sessionId);
export const sideLinkPrefix = 'maka-side:';
export function openSideLink(parentId: string, url: string) {
  if (!url.startsWith(sideLinkPrefix)) return false;
  openSideThread(parentId, url.slice(sideLinkPrefix.length));
  return true;
}

// Ranges of `markdown` a link must stay out of: code (fenced blocks and
// inline spans, where it would show as text), links, autolinks, HTML and URLs.
function blockedRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^ {0,3}(```+|~~~+)[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
  for (const match of markdown.matchAll(fence))
    ranges.push([match.index!, match.index! + match[0].length]);
  for (const pattern of [
    /(`+)[^`]*?\1/g,
    /!?\[[^\]\n]*\]\([^)\n]*\)/g,
    /<[^>\n]+>/g,
    /https?:\/\/\S+/g,
  ])
    for (const match of markdown.matchAll(pattern))
      ranges.push([match.index!, match.index! + match[0].length]);
  return ranges;
}

// Emphasis, strike and code marks, which the rendered text a passage is
// selected from leaves out, and the backslash of an escaped character.
const formatting = /[*_~`]/;
const punctuation = /[!-/:-@[-`{-~]/;
function withoutFormatting(text: string) {
  let plain = '';
  // Where each shown character sits in the source; an escape is one character.
  const spans: [number, number][] = [];
  // A link shows only its text: its brackets and target are left out too.
  const hidden = new Set<number>();
  for (const link of text.matchAll(/(!?\[)([^\]\n]*)\]\([^)\n]*\)/g)) {
    const start = link.index!;
    const textEnd = start + link[1].length + link[2].length;
    for (let at = start; at < start + link[1].length; at += 1) hidden.add(at);
    for (let at = textEnd; at < start + link[0].length; at += 1) hidden.add(at);
  }
  for (let at = 0; at < text.length; at += 1) {
    if (hidden.has(at)) continue;
    if (text[at] === '\\' && punctuation.test(text[at + 1] ?? '')) {
      plain += text[at + 1];
      spans.push([at, at + 2]);
      at += 1;
    } else if (!formatting.test(text[at])) {
      plain += text[at];
      spans.push([at, at + 1]);
    }
  }
  return { plain, spans };
}
// Source text made a link's text: its own brackets escaped, so they show as
// written and do not end the link; escapes already there are kept whole.
function linkText(text: string) {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '\\') {
      // A lone backslash at the end would escape the link's closing bracket.
      out += at + 1 < text.length ? char + text[at + 1] : '\\\\';
      at += 1;
    } else out += char === '[' || char === ']' ? `\\${char}` : char;
  }
  return out;
}

/**
 * The reply with each anchor's passage made a link to its thread (shown
 * underlined). A passage is found line by line as it appears in the source;
 * a line that crosses formatting is found without its marks and linked in the
 * pieces between them. Pieces in code stay unmarked.
 */
export function markPassages(markdown: string, marks: readonly SideAnchor[]): string {
  if (marks.length === 0) return markdown;
  const code = blockedRanges(markdown);
  const taken: [number, number, string][] = [];
  const free = (start: number, end: number) =>
    !code.some(([from, to]) => start < to && end > from) &&
    !taken.some(([from, to]) => start < to && end > from);
  let unformatted: ReturnType<typeof withoutFormatting> | undefined;
  for (const mark of marks) {
    for (const line of mark.quotes.flatMap((quote) => quote.split('\n'))) {
      const text = line.trim();
      if (text.length < 2) continue;
      let found = false;
      for (let at = markdown.indexOf(text); at >= 0; at = markdown.indexOf(text, at + 1)) {
        if (free(at, at + text.length)) {
          taken.push([at, at + text.length, mark.sessionId]);
          found = true;
          break;
        }
      }
      if (found) continue;
      unformatted ??= withoutFormatting(markdown);
      const { plain, spans } = unformatted;
      const wanted = withoutFormatting(text).plain;
      if (wanted.length < 2) continue;
      for (let at = plain.indexOf(wanted); at >= 0; at = plain.indexOf(wanted, at + 1)) {
        const pieces: [number, number][] = [];
        let start = spans[at][0];
        for (let index = at + 1; index <= at + wanted.length; index += 1) {
          const previous = spans[index - 1];
          if (index === at + wanted.length || spans[index][0] !== previous[1]) {
            pieces.push([start, previous[1]]);
            if (index < at + wanted.length) start = spans[index][0];
          }
        }
        const open = pieces.filter(([from, to]) => free(from, to));
        if (open.length === 0) continue;
        for (const [from, to] of open) taken.push([from, to, mark.sessionId]);
        break;
      }
    }
  }
  let out = markdown;
  for (const [start, end, id] of taken.sort((a, b) => b[0] - a[0]))
    out = `${out.slice(0, start)}[${linkText(out.slice(start, end))}](${sideLinkPrefix}${id})${out.slice(end)}`;
  return out;
}

type Query = (plugin: 'agent', method: string, input: unknown) => Promise<any>;

async function sideThreads(query: Query, parentId: string): Promise<AgentSession[]> {
  const found: AgentSession[] = [];
  let page: AgentSessionPage | null = null;
  for (let pages = 0; pages < 10; pages += 1) {
    page = await query('agent', 'list', {
      filter: 'all',
      includeArchived: false,
      scope: { kind: 'all' },
      position: page?.after
        ? { kind: 'after', revision: page.revision, cursor: page.after }
        : { kind: 'start' },
    });
    found.push(...page!.sessions.filter((session) => sideParent(session) === parentId));
    if (!page!.after) break;
  }
  return found;
}

function joinMessages(chunks: AgentHistoryChunk[], keep: (chunk: AgentHistoryChunk) => boolean) {
  const messages = new Map<string, { offset: number; text: string }[]>();
  for (const chunk of chunks) {
    if (!keep(chunk)) continue;
    const key = `${chunk.messageId}/${chunk.field}`;
    messages.set(key, [...(messages.get(key) ?? []), { offset: chunk.offset, text: chunk.text }]);
  }
  return [...messages.values()].map((parts) =>
    parts
      .sort((a, b) => a.offset - b.offset)
      .map((part) => part.text)
      .join(''),
  );
}

/**
 * What each side thread of `parentId` finished after `carried` (its last
 * carried turn, or the turn it was forked at), oldest thread first.
 */
export async function collectSideUpdates(
  query: Query,
  parentId: string,
  carried: ReadonlyMap<string, string>,
): Promise<SideThreadUpdate[]> {
  const updates: SideThreadUpdate[] = [];
  for (const session of (await sideThreads(query, parentId)).slice(0, 8)) {
    const observed: AgentObservation = await query('agent', 'observe', { sessionId: session.id });
    const last = observed.lastCompletedTurnId;
    const cursor = carried.get(session.id) ?? sideFromOf(observed.session);
    if (!last || last === cursor) continue;
    // Read back from the tail until the carried turn, keeping completed turns after it.
    const chunks: AgentHistoryChunk[] = [];
    let position: unknown = { kind: 'tail' };
    for (let pages = 0; pages < 8; pages += 1) {
      const page: AgentHistoryPage = await query('agent', 'history', {
        sessionId: session.id,
        through: observed.through,
        position,
        view: 'conversation',
      });
      chunks.unshift(...page.chunks);
      if (!page.before || (cursor && page.chunks.some((chunk) => chunk.turnId === cursor))) break;
      position = { kind: 'before', cursor: page.before };
    }
    const order = [...new Set(chunks.map((chunk) => chunk.turnId))];
    const from = cursor ? order.indexOf(cursor) + 1 : 0;
    const through = order.indexOf(last);
    if (through < from) continue;
    const turns = new Set(order.slice(from, through + 1));
    const inTurns = chunks.filter((chunk) => turns.has(chunk.turnId));
    const questions = joinMessages(
      inTurns,
      (chunk) => chunk.role === 'user' && chunk.field === 'body',
    );
    const answers = joinMessages(
      inTurns.filter((chunk) => chunk.turnId === last),
      (chunk) => chunk.role === 'assistant' && chunk.finalOutput === true,
    );
    if (questions.length === 0 && answers.length === 0) continue;
    updates.push({
      sessionId: session.id,
      title: observed.session.title,
      through: last,
      questions,
      answer: answers.join('\n\n'),
    });
  }
  return updates;
}

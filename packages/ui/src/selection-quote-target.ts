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

/**
 * Pure resolution of "what did the user select, and which turn does it belong
 * to". Kept free of DOM globals (`HTMLElement`, `Node`) so it can be tested
 * under plain Node, and so the hook that owns the listeners stays about timing
 * rather than about parsing.
 */

/**
 * The slice of a DOM node this module walks. Structural typing keeps real
 * nodes assignable while letting tests build plain object trees.
 */
export interface QuoteScopeNode {
  readonly parentNode: QuoteScopeNode | null;
  readonly dataset?: { readonly turnId?: string | undefined } | undefined;
}

/** A selection that is quotable: non-empty text owned by a known turn. */
export interface QuoteTarget {
  readonly text: string;
  readonly turnId: string;
}

/**
 * Collapses the whitespace a DOM selection picks up across element
 * boundaries. Returns null when nothing but whitespace was selected.
 */
export function normalizeQuoteText(raw: string): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * Walks up from `from` to `root`, returning the nearest `data-turn-id` seen on
 * the way. Reaching the top of the tree without meeting `root` returns null —
 * that is how a selection outside the transcript is rejected, so callers need
 * no separate containment check.
 *
 * The turn id is only honoured once `root` is actually reached. A turn id
 * found on an out-of-scope branch (the composer's quote chip carries one) must
 * not qualify that branch as quotable.
 */
export function findEnclosingTurnId(
  from: QuoteScopeNode | null,
  root: QuoteScopeNode,
): string | null {
  let node = from;
  let nearest: string | null = null;
  while (node) {
    if (node === root) return nearest;
    nearest ??= node.dataset?.turnId ?? null;
    node = node.parentNode;
  }
  return null;
}

/**
 * The single predicate behind the quote affordance: a selection is quotable
 * only when it carries text and sits inside a turn. Metadata that lives in the
 * transcript but outside any turn — timestamps, progress panels, host-injected
 * cards — resolves to null, because quoting it back to the model says nothing.
 *
 * A selection spanning two turns resolves to null for the same reason: its
 * common ancestor is above both turn roots, and attributing the excerpt to one
 * turn id would be a lie about where it came from.
 */
export function resolveQuoteTarget(
  rawText: string,
  container: QuoteScopeNode | null,
  root: QuoteScopeNode,
): QuoteTarget | null {
  const text = normalizeQuoteText(rawText);
  if (text === null) return null;
  const turnId = findEnclosingTurnId(container, root);
  if (turnId === null) return null;
  return { text, turnId };
}

/**
 * Rebuilds a DOM Range covering a stored excerpt inside a turn element, so a
 * staged quote's note can be edited where the excerpt lives rather than over
 * the composer's token. The match folds whitespace the way
 * {@link normalizeQuoteText} does — and one step further: a selection
 * spanning element boundaries stores newlines the raw text nodes never
 * carried, so a needle space also matches a bare transition between two
 * text nodes. Without that, a quote covering two paragraphs could never be
 * re-anchored on its own excerpt.
 */
export function findQuoteTextRange(turn: Element, excerpt: string): Range | null {
  const document = turn.ownerDocument;
  const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let raw = '';
  const nodeStart: number[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
    nodeStart.push(raw.length);
    raw += node.nodeValue ?? '';
  }
  const starts = new Set(nodeStart);
  const boundary: number[] = [];
  const isNodeStart: boolean[] = [];
  let haystack = '';
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i += 1) {
    if (/\s/.test(raw[i])) {
      if (haystack.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      haystack += ' ';
      boundary.push(i);
      isNodeStart.push(false);
      pendingSpace = false;
    }
    haystack += raw[i];
    boundary.push(i);
    isNodeStart.push(starts.has(i));
  }
  const needle = normalizeQuoteText(excerpt);
  if (needle === null) return null;
  let at = haystack.indexOf(needle);
  let end = at === -1 ? -1 : at + needle.length;
  if (at === -1 && needle.includes(' ')) {
    // The needle's first word is all literal characters, so a boundary-tolerant
    // match can only start where it appears contiguously.
    const firstWord = needle.slice(0, needle.indexOf(' '));
    for (let s = haystack.indexOf(firstWord); s !== -1; s = haystack.indexOf(firstWord, s + 1)) {
      let i = s;
      let j = 0;
      while (j < needle.length) {
        if (needle[j] === ' ') {
          if (haystack[i] === ' ') i += 1;
          else if (i >= haystack.length || !isNodeStart[i]) break;
          j += 1;
        } else if (haystack[i] === needle[j]) {
          i += 1;
          j += 1;
        } else {
          break;
        }
      }
      if (j === needle.length) {
        at = s;
        end = i;
        break;
      }
    }
  }
  if (at === -1) return null;
  // The needle is trimmed, so both ends resolve to real text-node characters.
  const startRaw = boundary[at];
  const endRaw = boundary[end - 1] + 1;
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && startRaw < offset + length) {
      range.setStart(node, startRaw - offset);
      started = true;
    }
    if (started && endRaw <= offset + length) {
      range.setEnd(node, endRaw - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

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

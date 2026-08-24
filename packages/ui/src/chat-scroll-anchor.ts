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

export interface ChatScrollAnchor {
  readonly turnId: string;
  readonly sender: string | undefined;
  readonly reverseIndex: number;
  readonly top: number;
  readonly element: HTMLElement;
}

const lastAnchorByRoot = new WeakMap<HTMLElement, HTMLElement>();

export function captureChatScrollAnchor(root: HTMLElement): ChatScrollAnchor | undefined {
  const rootTop = root.getBoundingClientRect().top;
  const article = firstVisibleArticle(root, rootTop);
  const turn = article?.closest<HTMLElement>('[data-turn-id]');
  const sender = article?.dataset.sender;
  const matches = turn
    ? Array.from(turn.querySelectorAll<HTMLElement>('article'))
      .filter((candidate) => candidate.dataset.sender === sender)
    : [];
  const index = article ? matches.indexOf(article) : -1;
  if (!article || !turn?.dataset.turnId || index < 0) return undefined;
  lastAnchorByRoot.set(root, article);
  return {
    turnId: turn.dataset.turnId,
    sender,
    reverseIndex: matches.length - index - 1,
    top: article.getBoundingClientRect().top,
    element: article,
  };
}

export function restoreChatScrollAnchor(
  root: HTMLElement,
  anchor: ChatScrollAnchor | undefined,
): boolean {
  if (!anchor) return false;
  const retainedTurn = anchor.element.closest<HTMLElement>('[data-turn-id]');
  let article =
    root.contains(anchor.element) &&
    retainedTurn?.dataset.turnId === anchor.turnId &&
    anchor.element.dataset.sender === anchor.sender
      ? anchor.element
      : undefined;
  if (!article) {
    const turn = root.querySelector<HTMLElement>(
      `[data-turn-id="${CSS.escape(anchor.turnId)}"]`,
    );
    const matches = turn
      ? Array.from(turn.querySelectorAll<HTMLElement>('article'))
        .filter((candidate) => candidate.dataset.sender === anchor.sender)
      : [];
    article = matches.at(-anchor.reverseIndex - 1);
  }
  if (!article) return false;
  lastAnchorByRoot.set(root, article);
  root.scrollTop += article.getBoundingClientRect().top - anchor.top;
  return true;
}

function firstVisibleArticle(root: HTMLElement, rootTop: number): HTMLElement | undefined {
  const cached = lastAnchorByRoot.get(root);
  let article = cached && root.contains(cached) ? cached : nextArticle(root, root);
  if (!article) return undefined;
  if (article.getBoundingClientRect().bottom > rootTop) {
    while (true) {
      const previous = previousArticle(root, article);
      if (!previous) break;
      if (previous.getBoundingClientRect().bottom <= rootTop) break;
      article = previous;
    }
    return article;
  }
  while ((article = nextArticle(root, article))) {
    if (article.getBoundingClientRect().bottom > rootTop) return article;
  }
  return undefined;
}

function nextArticle(root: HTMLElement, from: HTMLElement): HTMLElement | undefined {
  let node: HTMLElement | null = from;
  let descend = node.tagName !== 'ARTICLE';
  while (node) {
    if (descend && node.firstElementChild) {
      node = node.firstElementChild as HTMLElement;
    } else {
      while (node && node !== root && !node.nextElementSibling) node = node.parentElement;
      if (!node || node === root) return undefined;
      node = node.nextElementSibling as HTMLElement;
    }
    if (node.tagName === 'ARTICLE') return node;
    descend = true;
  }
  return undefined;
}

function previousArticle(root: HTMLElement, from: HTMLElement): HTMLElement | undefined {
  let node: HTMLElement | null = from;
  while (node && node !== root) {
    if (node.previousElementSibling) {
      node = node.previousElementSibling as HTMLElement;
      while (node.tagName !== 'ARTICLE' && node.lastElementChild) {
        node = node.lastElementChild as HTMLElement;
      }
    } else {
      node = node.parentElement;
    }
    if (node?.tagName === 'ARTICLE') return node;
  }
  return undefined;
}

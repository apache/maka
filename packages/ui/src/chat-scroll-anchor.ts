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
  while (node) {
    if (node.firstElementChild) {
      node = node.firstElementChild as HTMLElement;
    } else {
      while (node && node !== root && !node.nextElementSibling) node = node.parentElement;
      if (!node || node === root) return undefined;
      node = node.nextElementSibling as HTMLElement;
    }
    if (node.tagName === 'ARTICLE') return node;
  }
  return undefined;
}

function previousArticle(root: HTMLElement, from: HTMLElement): HTMLElement | undefined {
  let node: HTMLElement | null = from;
  while (node && node !== root) {
    if (node.previousElementSibling) {
      node = node.previousElementSibling as HTMLElement;
      while (node.lastElementChild) node = node.lastElementChild as HTMLElement;
    } else {
      node = node.parentElement;
    }
    if (node?.tagName === 'ARTICLE') return node;
  }
  return undefined;
}

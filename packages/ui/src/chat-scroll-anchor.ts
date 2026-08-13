export interface ChatScrollAnchor {
  readonly turnId: string;
  readonly sender: string | undefined;
  readonly reverseIndex: number;
  readonly top: number;
}

export function captureChatScrollAnchor(root: HTMLElement): ChatScrollAnchor | undefined {
  const rootTop = root.getBoundingClientRect().top;
  const article = Array.from(root.querySelectorAll<HTMLElement>('article'))
    .find((candidate) => candidate.getBoundingClientRect().bottom > rootTop);
  const turn = article?.closest<HTMLElement>('[data-turn-id]');
  const sender = article?.dataset.sender;
  const matches = turn
    ? Array.from(turn.querySelectorAll<HTMLElement>('article'))
      .filter((candidate) => candidate.dataset.sender === sender)
    : [];
  const index = article ? matches.indexOf(article) : -1;
  if (!article || !turn?.dataset.turnId || index < 0) return undefined;
  return {
    turnId: turn.dataset.turnId,
    sender,
    reverseIndex: matches.length - index - 1,
    top: article.getBoundingClientRect().top,
  };
}

export function restoreChatScrollAnchor(
  root: HTMLElement,
  anchor: ChatScrollAnchor | undefined,
): boolean {
  if (!anchor) return false;
  const turn = root.querySelector<HTMLElement>(
    `[data-turn-id="${CSS.escape(anchor.turnId)}"]`,
  );
  const matches = turn
    ? Array.from(turn.querySelectorAll<HTMLElement>('article'))
      .filter((candidate) => candidate.dataset.sender === anchor.sender)
    : [];
  const article = matches.at(-anchor.reverseIndex - 1);
  if (!article) return false;
  root.scrollTop += article.getBoundingClientRect().top - anchor.top;
  return true;
}

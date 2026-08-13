import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { captureChatScrollAnchor, restoreChatScrollAnchor } from '../chat-scroll-anchor.js';

test('reuses the visible article while progressive history grows above it', () => {
  const { document } = parseHTML('<main id="root"></main>');
  const root = document.querySelector<HTMLElement>('#root')!;
  Object.defineProperty(root, 'scrollTop', { value: 0, writable: true });
  root.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  let rectReads = 0;
  for (let index = 0; index < 200; index += 1) {
    const turn = document.createElement('section');
    turn.dataset.turnId = `turn-${index}`;
    const article = document.createElement('article');
    article.dataset.sender = 'assistant';
    article.getBoundingClientRect = () => {
      rectReads += 1;
      return { top: index < 180 ? 0 : 120, bottom: index < 180 ? 80 : 160 } as DOMRect;
    };
    turn.append(article);
    root.append(turn);
  }

  const first = captureChatScrollAnchor(root);
  assert.equal(first?.turnId, 'turn-180');
  rectReads = 0;
  const second = captureChatScrollAnchor(root);
  assert.equal(second?.turnId, 'turn-180');
  assert.ok(rectReads <= 4);
  assert.equal(restoreChatScrollAnchor(root, second), true);
});

import { PROMPT_RAIL_SESSION_ID } from '../src/main/e2e-fixture/seed-helpers.js';
import {
  desktopSessionKey,
  parseDesktopSessionKey,
} from '../src/shared/runtime-host-identity.js';
import { expect, test } from './fixtures.js';

test('fixture-seeded transcripts return content hits with turn ids', async ({
  promptRailWindow: page,
}) => {
  const outcome = await page.evaluate(async () =>
    window.maka.search.thread({
      source: 'thread',
      query: '第 3 个问题',
      limit: 10,
    }),
  );

  expect(Array.isArray(outcome), JSON.stringify(outcome)).toBe(true);
  if (!Array.isArray(outcome)) return;

  const content = outcome.find(
    (hit) =>
      hit.target?.kind === 'thread' &&
      hit.target.turnId === 'turn-prompt-rail-3',
  );
  expect(content?.summary).toBe('用户消息');
  if (!content || content.target?.kind !== 'thread') {
    throw new Error(`expected a thread search hit, got ${JSON.stringify(content)}`);
  }
  const { hostId } = parseDesktopSessionKey(content.target.sessionId);
  expect(content.target).toEqual({
    kind: 'thread',
    sessionId: desktopSessionKey({ hostId, sessionId: PROMPT_RAIL_SESSION_ID }),
    turnId: 'turn-prompt-rail-3',
    sequence: 4,
  });
});

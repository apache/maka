import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUTO_RECAP_IDLE_MS,
  AUTO_RECAP_MIN_TURNS,
  cleanRecapText,
  shouldAutoRecap,
} from '../session-recap.js';

describe('cleanRecapText', () => {
  test('normalizes whitespace, labels, and wrapping quotes', () => {
    const cases = [
      ['  We   fixed\n\nthe   bug.  ', 'We fixed the bug.'],
      ['Recap: We fixed the bug.', 'We fixed the bug.'],
      ['RECAP:We fixed the bug.', 'We fixed the bug.'],
      ['Summary:  We fixed the bug.', 'We fixed the bug.'],
      ['summary：We fixed the bug.', 'We fixed the bug.'],
      ['回顾：我们修复了问题。', '我们修复了问题。'],
      ['"We fixed the bug."', 'We fixed the bug.'],
      ["'We fixed the bug.'", 'We fixed the bug.'],
      ['“We fixed the bug.”', 'We fixed the bug.'],
    ];

    for (const [input, expected] of cases) {
      assert.equal(cleanRecapText(input), expected, input);
    }
  });

  test('truncates to 1200 characters with an ellipsis', () => {
    const long = 'a'.repeat(1300);
    const result = cleanRecapText(long);
    assert.equal(result.length, 1201);
    assert.equal(result.slice(0, 1200), 'a'.repeat(1200));
    assert.equal(result.at(-1), '…');
  });
});

describe('shouldAutoRecap', () => {
  test('enforces idle, turn-count, and watermark boundaries', () => {
    const cases = [
      [{ idleMs: AUTO_RECAP_IDLE_MS - 1, mainTurnCount: 3, lastRecapMainTurnCount: 0 }, false],
      [{ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 3, lastRecapMainTurnCount: 0 }, true],
      [
        {
          idleMs: AUTO_RECAP_IDLE_MS,
          mainTurnCount: AUTO_RECAP_MIN_TURNS - 1,
          lastRecapMainTurnCount: 0,
        },
        false,
      ],
      [
        {
          idleMs: AUTO_RECAP_IDLE_MS,
          mainTurnCount: AUTO_RECAP_MIN_TURNS,
          lastRecapMainTurnCount: 0,
        },
        true,
      ],
      [{ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 3, lastRecapMainTurnCount: 3 }, false],
      [{ idleMs: AUTO_RECAP_IDLE_MS, mainTurnCount: 4, lastRecapMainTurnCount: 3 }, true],
    ] as const;

    for (const [input, expected] of cases) {
      assert.equal(shouldAutoRecap(input), expected, JSON.stringify(input));
    }
  });
});

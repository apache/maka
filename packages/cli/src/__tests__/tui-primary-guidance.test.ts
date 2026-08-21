import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import { getTuiPrimaryGuidance } from '../tui-primary-guidance.js';

describe('TUI primary guidance catalog', () => {
  test('both locales describe every TUI slash command', () => {
    const expected = slashCommandsForSurface('tui')
      .map((command) => command.id)
      .sort();

    for (const locale of ['zh', 'en'] as const) {
      assert.deepEqual(Object.keys(getTuiPrimaryGuidance(locale).commands).sort(), expected);
    }
  });

  test('keeps keybinding tokens identical across locales', () => {
    const tokens = (locale: 'zh' | 'en') =>
      getTuiPrimaryGuidance(locale).help.keybindings.flatMap((line) => {
        const match = /^\s*(.*?)\s*—/u.exec(line);
        return match ? [match[1]!.replace(/\s*[（(].*$/u, '')] : [];
      });

    assert.deepEqual(tokens('zh'), tokens('en'));
  });
});

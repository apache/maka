import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  ansi,
  disc,
  stripAnsi,
  _setColorLevelForTesting,
  _detectColorLevelForTesting as detect,
} from '../tui-ansi.js';

// Reset to truecolor (the development default) after each test so a test that
// changes the level never leaks into the next one.
afterEach(() => _setColorLevelForTesting(3));

describe('tui-ansi semantic slots (#1053)', () => {
  test('renders a single ● glyph regardless of tone', () => {
    _setColorLevelForTesting(3);
    for (const tone of ['ok', 'muted', 'accent', 'danger'] as const) {
      assert.equal(stripAnsi(disc(tone)), '●', `tone ${tone} should yield one ●`);
    }
  });
});

describe('color capability fallback (#1064)', () => {
  test('adapts semantic and basic styles to each terminal color level', () => {
    const cases = [
      [3, '\x1b[38;2;87;163;239mx\x1b[39m', '\x1b[38;2;128;132;140mx\x1b[39m', '\x1b[1mx\x1b[22m'],
      [2, '\x1b[38;5;75mx\x1b[39m', '\x1b[38;5;102mx\x1b[39m', '\x1b[1mx\x1b[22m'],
      [1, '\x1b[37mx\x1b[39m', '\x1b[90mx\x1b[39m', '\x1b[1mx\x1b[22m'],
      [0, 'x', 'x', 'x'],
    ] as const;

    for (const [level, accent, muted, bold] of cases) {
      _setColorLevelForTesting(level);
      assert.equal(ansi.accent('x'), accent, `accent level ${level}`);
      assert.equal(ansi.muted('x'), muted, `muted level ${level}`);
      assert.equal(ansi.bold('x'), bold, `bold level ${level}`);
    }
  });
});

describe('detectColorLevel env detection (#1064)', () => {
  test('maps environment capabilities and overrides to color levels', () => {
    const cases: Array<[Record<string, string>, number]> = [
      [{ NO_COLOR: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor' }, 0],
      [{ NO_COLOR: '0', TERM: 'xterm-256color' }, 0],
      [{ NO_COLOR: '', TERM: 'xterm-256color', COLORTERM: 'truecolor' }, 3],
      [{}, 0],
      [{ TERM: '' }, 0],
      [{ TERM: 'dumb' }, 0],
      [{ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, 3],
      [{ TERM: 'xterm', COLORTERM: '24bit' }, 3],
      [{ TERM: 'xterm-truecolor' }, 3],
      [{ TERM: 'tmux-24bit' }, 3],
      [{ TERM: 'xterm-256color' }, 2],
      [{ TERM: 'screen-256color' }, 2],
      [{ TERM: 'xterm' }, 1],
      [{ TERM: 'screen' }, 1],
      [{ TERM: 'rxvt-unicode' }, 1],
    ];

    for (const [env, expected] of cases) {
      assert.equal(detect(env), expected, JSON.stringify(env));
    }
  });
});

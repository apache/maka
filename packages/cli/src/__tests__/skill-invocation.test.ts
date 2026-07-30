import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { TUI } from '@earendil-works/pi-tui';
import type { InvocableSkillEntry } from '@maka/runtime';
import { MakaAutocompleteProvider } from '../pi-tui-pickers.js';
import { MakaSkillHighlightEditor } from '../skill-highlight-editor.js';
import {
  parseSkillInvocationTokens,
  skillInvocationPrefixAt,
  stripSkillInvocationTokens,
} from '../skill-token.js';
import { _setColorLevelForTesting, editorTheme } from '../tui-ansi.js';
import { FakeTerminal } from './tui-terminal-mock.js';

// Pin truecolor so accent escape assertions are hermetic (mirrors the runner tests).
before(() => _setColorLevelForTesting(3));

describe('skill invocation tokens', () => {
  test('parses tokens anywhere in text, deduped case-insensitively, in order', () => {
    const tokens = parseSkillInvocationTokens(
      '帮我 /skill:weekly-report 整理\n然后 /skill:Alpha 和 /skill:WEEKLY-REPORT 各来一遍',
    );
    assert.deepEqual(
      tokens.map((token) => token.name),
      ['weekly-report', 'Alpha'],
    );
    assert.equal(tokens[0].start, 3);
    assert.equal(tokens[0].end, 3 + '/skill:weekly-report'.length);
  });

  test('rejects path-like and colon-less occurrences', () => {
    assert.deepEqual(parseSkillInvocationTokens('cat docs/skill:alpha'), []);
    assert.deepEqual(parseSkillInvocationTokens('/skill alpha'), []);
    assert.deepEqual(parseSkillInvocationTokens('/skill:'), []);
    assert.deepEqual(parseSkillInvocationTokens('看 https://example.com/skill:x'), []);
  });

  test('token name stops at the id charset boundary', () => {
    const tokens = parseSkillInvocationTokens('/skill:alpha，整理一下');
    assert.deepEqual(
      tokens.map((token) => token.name),
      ['alpha'],
    );
  });

  test('strips named tokens and tidies only the touched lines', () => {
    const text = [
      '帮我 /skill:alpha 整理一下',
      '```',
      'code  with  double  spaces',
      '```',
      '/skill:beta',
      '收尾 /skill:ALPHA',
    ].join('\n');
    const stripped = stripSkillInvocationTokens(text, new Set(['alpha', 'beta']));
    assert.equal(
      stripped,
      ['帮我 整理一下', '```', 'code  with  double  spaces', '```', '收尾'].join('\n'),
    );
  });

  test('keeps unresolved tokens literal', () => {
    const text = '用 /skill:nope 和 /skill:alpha 处理';
    assert.equal(stripSkillInvocationTokens(text, new Set(['alpha'])), '用 /skill:nope 和 处理');
  });

  test('preserves indented code after a token-only line (no global trim)', () => {
    const stripped = stripSkillInvocationTokens(
      '/skill:alpha\n    make target\n',
      new Set(['alpha']),
    );
    assert.equal(stripped, '    make target\n');
  });

  test('detects the autocomplete prefix at the cursor', () => {
    assert.deepEqual(skillInvocationPrefixAt(['帮我 /skill:we 整理'], 0, 12), {
      prefix: '/skill:we',
      query: 'we',
    });
    assert.deepEqual(skillInvocationPrefixAt(['/skill:'], 0, 7), { prefix: '/skill:', query: '' });
    assert.equal(skillInvocationPrefixAt(['/skill:we 整理'], 0, 10), null, 'cursor past the token');
    assert.equal(skillInvocationPrefixAt(['/skill we'], 0, 8), null, 'no colon, no token');
    assert.equal(
      skillInvocationPrefixAt(['docs/skill:we'], 0, 13),
      null,
      'path-like prefix rejected',
    );
  });
});

describe('skill autocomplete', () => {
  const skills: InvocableSkillEntry[] = [
    {
      ref: 'workspace:legacy:weekly-report',
      id: 'weekly-report',
      name: '写周报',
      description: '把进展整理成周报。',
    },
    { ref: 'workspace:legacy:alpha', id: 'alpha', name: 'Alpha', description: 'First.' },
    {
      ref: 'workspace:legacy:data-crunch',
      id: 'data-crunch',
      name: 'Alpha Stats',
      description: 'Crunches.',
    },
  ];
  const listSkills = async () => skills;

  test('suggests by id prefix or name substring, suppressing file completion', async () => {
    const provider = new MakaAutocompleteProvider('/repo', [], listSkills);
    const byId = await provider.getSuggestions(['/skill:we'], 0, 9, {
      signal: new AbortController().signal,
    });
    assert.deepEqual(
      byId?.items.map((item) => item.value),
      ['weekly-report'],
    );
    assert.equal(byId?.prefix, '/skill:we');
    assert.equal(byId?.items[0]?.label, '/skill:weekly-report');
    assert.equal(byId?.items[0]?.description, '写周报 · 把进展整理成周报。');

    // 'alpha' matches id `alpha` directly and `data-crunch` via its display name.
    const byName = await provider.getSuggestions(['帮我 /skill:alpha 整理'], 0, 15, {
      signal: new AbortController().signal,
    });
    assert.deepEqual(
      byName?.items.map((item) => item.value),
      ['alpha', 'data-crunch'],
    );

    const noMatch = await provider.getSuggestions(['/skill:zzz'], 0, 10, {
      signal: new AbortController().signal,
    });
    assert.equal(noMatch, null, 'no skill match closes the popup instead of offering paths');
  });

  test('wins over slash-command completion at line start', async () => {
    const provider = new MakaAutocompleteProvider(
      '/repo',
      [{ name: 'skill', description: 'Invoke a skill' }],
      listSkills,
    );
    const suggestions = await provider.getSuggestions(['/skill:dat'], 0, 10, {
      signal: new AbortController().signal,
    });
    assert.deepEqual(
      suggestions?.items.map((item) => item.value),
      ['data-crunch'],
    );
  });

  test('applies completion as a token with trailing space, mid-line', () => {
    const provider = new MakaAutocompleteProvider('/repo', [], listSkills);
    const applied = provider.applyCompletion(
      ['帮我 /skill:we 一下'],
      0,
      12,
      { value: 'weekly-report', label: '/skill:weekly-report' },
      '/skill:we',
    );
    assert.deepEqual(applied.lines, ['帮我 /skill:weekly-report  一下']);
    assert.equal(applied.lines[0].slice(0, applied.cursorCol), '帮我 /skill:weekly-report ');
  });

  test('never triggers file completion inside a token', () => {
    const provider = new MakaAutocompleteProvider('/repo', [], listSkills);
    assert.equal(provider.shouldTriggerFileCompletion(['/skill:we'], 0, 9), false);
  });
});

describe('skill token highlight', () => {
  test('accents valid tokens only', () => {
    const tui = new TUI(new FakeTerminal());
    const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
    editor.setSkillTokenValidator((name) => name.toLowerCase() === 'alpha');
    editor.setText('帮我 /skill:alpha 和 /skill:nope 整理');
    const rendered = editor.render(80);
    const line = rendered.find((candidate) => candidate.includes('/skill:alpha'));
    assert.ok(line, 'token line renders');
    assert.ok(
      line.includes('\x1b[38;2;87;163;239m/skill:alpha\x1b[39m'),
      `valid token carries the brand accent: ${JSON.stringify(line)}`,
    );
    assert.ok(
      !line.includes('\x1b[38;2;87;163;239m/skill:nope\x1b[39m'),
      'invalid token stays plain',
    );
  });
});

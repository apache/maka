import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { Editor, setKittyProtocolActive, TUI } from '@earendil-works/pi-tui';
import type { InvocableSkillEntry } from '@maka/runtime';
import { DirectoryAutocompleteProvider, MakaAutocompleteProvider } from '../pi-tui-pickers.js';
import { MakaSkillHighlightEditor } from '../skill-highlight-editor.js';
import { editorTheme } from '../tui-ansi.js';
import { FakeTerminal, waitFor } from './tui-terminal-mock.js';

// Mid-message slash completion (issue #1100). Only `/skill:<name>` has semantic
// value mid-message: it is a parseable invocation token, whereas `/compact`,
// `/model`, etc. only execute at line start (`handleSlashCommand` checks
// `parts[0]`). So mid-message completion is skill-only; plain commands stay
// line-start-only.
//
// No-auto-submit half: for a mid-message `/skill:` token the provider returns a
// prefix WITHOUT the `/skill:` head (just the query, e.g. `w`), so pi-tui's
// select-confirm guard (submit only when `autocompletePrefix` starts with `/`)
// does not fire. Line-start keeps `/skill:query` so select still submits (the
// existing "select to invoke" UX).

describe('MakaAutocompleteProvider mid-message skill completion', () => {
  const commands = [
    { name: 'compact', description: 'compact the transcript' },
    { name: 'config', description: 'open config' },
    { name: 'model', description: 'switch model' },
  ];
  const skills: InvocableSkillEntry[] = [
    {
      ref: 'workspace:legacy:weekly-report',
      id: 'weekly-report',
      name: 'Weekly Report',
      description: 'summarize the week',
    },
    {
      ref: 'workspace:legacy:web-search',
      id: 'web-search',
      name: 'Web Search',
      description: 'search the web',
    },
  ];
  const listSkills = async (): Promise<readonly InvocableSkillEntry[]> => skills;
  const signal = new AbortController().signal;
  let baseDir: string;
  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'maka-skill-'));
  });

  test('completes and applies a mid-message `/skill:` token without a submit prefix', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['see /skill:w'], 0, 12, { signal });
    assert.equal(result?.prefix, 'w');
    assert.deepEqual(
      (result?.items ?? []).map((i) => i.value),
      ['weekly-report', 'web-search'],
    );
    const applied = provider.applyCompletion(
      ['see /skill:w'],
      0,
      12,
      { value: 'weekly-report', label: '/skill:weekly-report' },
      'w',
    );
    assert.deepEqual(applied.lines, ['see /skill:weekly-report ']);
    assert.equal(applied.cursorCol, 'see /skill:weekly-report '.length);
  });

  test('keeps plain commands and non-first-line skills out of mid-message completion', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const plain = await provider.getSuggestions(['see /co'], 0, 7, { signal });
    assert.equal(
      (plain?.items ?? []).some((item) => commands.some((command) => command.name === item.value)),
      false,
    );
    const secondLine = await provider.getSuggestions(['first', 'see /skill:w'], 1, 12, {
      signal,
    });
    assert.equal(
      (secondLine?.items ?? []).some((item) => skills.some((skill) => skill.id === item.value)),
      false,
    );
  });

  test('filters and applies skill completion from a bare mid-message slash', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    for (const [line, column, prefix] of [
      ['see /', 5, ''],
      ['see /w', 6, 'w'],
    ] as const) {
      const result = await provider.getSuggestions([line], 0, column, { signal });
      assert.equal(result?.prefix, prefix, line);
      assert.deepEqual(
        (result?.items ?? []).map((item) => item.value),
        ['skill:weekly-report', 'skill:web-search'],
        line,
      );
    }
    const applied = provider.applyCompletion(
      ['see /'],
      0,
      5,
      { value: 'skill:weekly-report', label: '/skill:weekly-report' },
      '',
    );
    assert.deepEqual(applied.lines, ['see /skill:weekly-report ']);
    assert.equal(applied.cursorCol, 'see /skill:weekly-report '.length);
  });

  test('a bare mid-message slash with no skill match never falls through to files', async () => {
    const provider = new MakaAutocompleteProvider('/', commands, listSkills);
    assert.equal(await provider.getSuggestions(['see /zzz'], 0, 8, { signal }), null);
    assert.equal(await provider.getSuggestions(['see /U'], 0, 6, { signal }), null);
  });

  test('keeps the original Unicode prefix length when applying a completion', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, async () => [
      { ref: 'workspace:legacy:info', id: 'info', name: 'İnfo', description: '' },
    ]);
    const result = await provider.getSuggestions(['see /İ'], 0, 6, { signal });
    assert.equal(result?.prefix, 'İ');
    assert.ok(result && result.items.length > 0);
    const applied = provider.applyCompletion(['see /İ'], 0, 6, result.items[0], result.prefix);
    assert.deepEqual(applied.lines, ['see /skill:info ']);
  });
});

describe('DirectoryAutocompleteProvider', () => {
  test('reuses path completion while filtering out files', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'maka-move-picker-'));
    mkdirSync(join(baseDir, 'worktree-next'));
    writeFileSync(join(baseDir, 'notes.txt'), 'notes');
    try {
      const provider = new DirectoryAutocompleteProvider(baseDir);
      const result = await provider.getSuggestions([''], 0, 0, {
        signal: new AbortController().signal,
        force: true,
      });
      assert.deepEqual(
        result?.items.map((item) => item.label),
        ['worktree-next/'],
      );
    } finally {
      // The test directory is intentionally tiny; remove it synchronously so
      // the provider test does not need a second async lifecycle hook.
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('applies the first absolute path segment without adding a second slash', () => {
    const provider = new DirectoryAutocompleteProvider('/');
    const applied = provider.applyCompletion(
      ['/U'],
      0,
      2,
      { value: 'Users/', label: 'Users/' },
      '/U',
    );
    assert.deepEqual(applied.lines, ['/Users/ ']);
    assert.equal(applied.cursorCol, '/Users/ '.length);
  });
});

describe('MakaSkillHighlightEditor mid-message skill trigger', () => {
  const commands = [
    { name: 'compact', description: 'compact the transcript' },
    { name: 'config', description: 'open config' },
  ];
  const skills: InvocableSkillEntry[] = [
    {
      ref: 'workspace:legacy:weekly-report',
      id: 'weekly-report',
      name: 'Weekly Report',
      description: 'summarize the week',
    },
    {
      ref: 'workspace:legacy:web-search',
      id: 'web-search',
      name: 'Web Search',
      description: 'search the web',
    },
  ];
  const listSkills = async (): Promise<readonly InvocableSkillEntry[]> => skills;

  test('selecting a mid-message skill completes without submitting', async () => {
    const tui = new TUI(new FakeTerminal());
    const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
    editor.setAutocompleteProvider(new MakaAutocompleteProvider(tmpdir(), commands, listSkills));
    let submitted: string | undefined;
    editor.onSubmit = (prompt: string) => {
      submitted = prompt;
    };
    for (const ch of 'see /skill:w') editor.handleInput(ch);
    await waitFor(() => editor.isShowingAutocomplete());
    const rendered = editor.render(80).join('\n');
    assert.match(rendered, /\/skill:weekly-report/);
    assert.match(rendered, /\/skill:web-search/);
    editor.handleInput('\r');
    assert.equal(submitted, undefined);
    assert.deepEqual(editor.getLines(), ['see /skill:weekly-report ']);
  });

  test('typing a bare `/` mid-message triggers skill autocomplete', async () => {
    const tui = new TUI(new FakeTerminal());
    const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
    editor.setAutocompleteProvider(new MakaAutocompleteProvider(tmpdir(), commands, listSkills));
    for (const ch of 'see /') editor.handleInput(ch);
    await waitFor(() => editor.isShowingAutocomplete());
    const rendered = editor.render(80).join('\n');
    assert.ok(
      rendered.includes('/skill:weekly-report'),
      `expected /skill:weekly-report in:\n${rendered}`,
    );
    assert.ok(
      rendered.includes('/skill:web-search'),
      `expected /skill:web-search in:\n${rendered}`,
    );
  });

  test('mid-message trigger supports Kitty and xterm encoded printable input', async () => {
    const protocols = [
      {
        kitty: true,
        text: 'see /skill:w',
        encode: (codePoint: number) => `\x1b[${codePoint}u`,
      },
      {
        kitty: false,
        text: 'see /',
        encode: (codePoint: number) => `\x1b[27;1;${codePoint}~`,
      },
    ];

    for (const protocol of protocols) {
      setKittyProtocolActive(protocol.kitty);
      try {
        const tui = new TUI(new FakeTerminal());
        const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
        editor.setAutocompleteProvider(
          new MakaAutocompleteProvider(tmpdir(), commands, listSkills),
        );
        for (const character of protocol.text) {
          editor.handleInput(protocol.encode(character.codePointAt(0) ?? 0));
        }
        await waitFor(() => editor.isShowingAutocomplete());
        assert.match(editor.render(80).join('\n'), /\/skill:weekly-report/);
      } finally {
        setKittyProtocolActive(false);
      }
    }
  });
});

describe('pi-tui Editor contract (mid-message trigger dependency)', () => {
  test('tryTriggerAutocomplete is a runtime-callable prototype method', () => {
    // MakaSkillHighlightEditor.handleInput calls this TS-private method; pi-tui
    // ships plain JS (no #private fields), so it is reachable at runtime. Pin it
    // so a pi-tui upgrade that renames or makes it truly private fails loudly
    // instead of silently regressing mid-message skill completion.
    assert.equal(
      typeof (Editor.prototype as unknown as Record<string, unknown>).tryTriggerAutocomplete,
      'function',
    );
  });
});

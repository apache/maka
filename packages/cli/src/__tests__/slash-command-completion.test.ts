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

  test('completes a `/skill:` token mid-message with a slash-less prefix', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['see /skill:w'], 0, 12, { signal });
    assert.equal(
      result?.prefix,
      'w',
      'mid-message prefix must drop /skill: so select does not submit',
    );
    assert.deepEqual(
      (result?.items ?? []).map((i) => i.value),
      ['weekly-report', 'web-search'],
    );
  });

  test('applies a mid-message skill completion as `/skill:name ` (no submit)', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    await provider.getSuggestions(['see /skill:w'], 0, 12, { signal });
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

  test('does NOT complete plain commands mid-message (only line start)', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['see /co'], 0, 7, { signal });
    assert.equal(
      (result?.items ?? []).some((i) => commands.some((c) => c.name === i.value)),
      false,
      'plain commands must not complete mid-message',
    );
  });

  test('line-start skill completion is unchanged (prefix keeps `/skill:`)', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['/skill:w'], 0, 8, { signal });
    assert.equal(result?.prefix, '/skill:w');
    assert.deepEqual(
      (result?.items ?? []).map((i) => i.value),
      ['weekly-report', 'web-search'],
    );
  });

  test('line-start plain command completion is unchanged', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['/co'], 0, 3, { signal });
    assert.equal(result?.prefix, '/co');
    assert.deepEqual(
      (result?.items ?? []).map((i) => i.value),
      ['compact', 'config'],
    );
  });

  test('mid-message skill completion is first-line only', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['first', 'see /skill:w'], 1, 12, { signal });
    assert.equal(
      (result?.items ?? []).some((i) => skills.some((s) => s.id === i.value)),
      false,
      'a `/skill:` on a non-first line must not surface skill completion',
    );
  });

  test('completes `/skill:xxx` from a bare mid-message `/` token', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['see /'], 0, 5, { signal });
    assert.equal(
      result?.prefix,
      '',
      'bare / prefix is empty (slash-less) so select does not submit',
    );
    assert.deepEqual(
      (result?.items ?? []).map((i) => i.value),
      ['skill:weekly-report', 'skill:web-search'],
    );
  });

  test('filters bare mid-message `/` completions by the text after `/`', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['see /w'], 0, 6, { signal });
    assert.equal(result?.prefix, 'w');
    assert.deepEqual(
      (result?.items ?? []).map((i) => i.value),
      ['skill:weekly-report', 'skill:web-search'],
    );
  });

  test('applies a bare mid-message `/` skill completion as `/skill:name `', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    await provider.getSuggestions(['see /'], 0, 5, { signal });
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

  test('a bare mid-message `/` with no skill match does not surface skills', async () => {
    const provider = new MakaAutocompleteProvider(baseDir, commands, listSkills);
    const result = await provider.getSuggestions(['see /zzz'], 0, 8, { signal });
    assert.equal(
      (result?.items ?? []).some((i) =>
        skills.some((s) => s.id === i.value || `skill:${s.id}` === i.value),
      ),
      false,
    );
  });

  test('a bare mid-message `/` with no skill match does NOT fall through to file completion', async () => {
    // Regression: falling through to the file provider returns a `/`-prefixed
    // prefix, and pi-tui auto-submits on select when prefix starts with `/` -
    // so selecting the file item would send the unfinished message. Mid-message
    // `/`-path completion was not available before this PR either (pi-tui
    // excludes `/` from triggerCharacters), so returning null restores prior
    // behavior instead of introducing an auto-submit footgun.
    const provider = new MakaAutocompleteProvider('/', commands, listSkills);
    const result = await provider.getSuggestions(['see /U'], 0, 6, { signal });
    assert.equal(
      result,
      null,
      'must not fall through to file provider (would auto-submit on select)',
    );
  });

  test('a bare mid-message `/` keeps the original (non-lowercased) prefix for apply', async () => {
    // Regression: toLowerCase can change UTF-16 length (e.g. "İ" -> "i̇", len 1->2).
    // Using the lowercased query as the replacement prefix makes applyCompletion
    // slice by the wrong length, over-deleting the original text.
    const provider = new MakaAutocompleteProvider(baseDir, commands, async () => [
      { ref: 'workspace:legacy:info', id: 'info', name: 'İnfo', description: '' },
    ]);
    const result = await provider.getSuggestions(['see /İ'], 0, 6, { signal });
    assert.equal(result?.prefix, 'İ', 'prefix must be the original text, not its lowercased form');
    assert.ok(result && result.items.length > 0, 'expected a skill match');
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

  test('typing `/skill:` mid-message triggers skill autocomplete', async () => {
    const tui = new TUI(new FakeTerminal());
    const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
    editor.setAutocompleteProvider(new MakaAutocompleteProvider(tmpdir(), commands, listSkills));
    for (const ch of 'see /skill:w') editor.handleInput(ch);
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

  test('selecting a mid-message skill inserts `/skill:name ` and does not submit', async () => {
    const tui = new TUI(new FakeTerminal());
    const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
    editor.setAutocompleteProvider(new MakaAutocompleteProvider(tmpdir(), commands, listSkills));
    let submitted: string | undefined;
    editor.onSubmit = (prompt: string) => {
      submitted = prompt;
    };
    for (const ch of 'see /skill:w') editor.handleInput(ch);
    await waitFor(() => editor.isShowingAutocomplete());
    editor.handleInput('\r');
    assert.equal(submitted, undefined, 'mid-message skill select must not submit');
    assert.deepEqual(editor.getLines(), ['see /skill:weekly-report ']);
  });

  test('typing a plain command mid-message does NOT surface plain commands', async () => {
    const tui = new TUI(new FakeTerminal());
    const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
    editor.setAutocompleteProvider(new MakaAutocompleteProvider(tmpdir(), commands, listSkills));
    for (const ch of 'see /co') editor.handleInput(ch);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const rendered = editor.render(80).join('\n');
    // `/co` may trigger file completion (e.g. /cores), but plain slash commands
    // must never appear mid-message - they only execute at line start.
    assert.ok(!rendered.includes('/compact'), 'plain commands must not complete mid-message');
    assert.ok(!rendered.includes('/config'));
    assert.ok(!rendered.includes('/model'));
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

  test('mid-message trigger works under Kitty CSI-u keyboard protocol', async () => {
    // Regression: a Kitty keyboard terminal encodes printable chars as CSI-u
    // (starting with ESC). A naive `data.startsWith('\x1b')` guard skipped
    // them, so the text was inserted but the completion menu never appeared.
    setKittyProtocolActive(true);
    try {
      const tui = new TUI(new FakeTerminal());
      const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
      editor.setAutocompleteProvider(new MakaAutocompleteProvider(tmpdir(), commands, listSkills));
      for (const ch of 'see /skill:w') editor.handleInput(`\x1b[${ch.codePointAt(0)}u`);
      await waitFor(() => editor.isShowingAutocomplete());
      const rendered = editor.render(80).join('\n');
      assert.ok(
        rendered.includes('/skill:weekly-report'),
        `expected skill completion under Kitty CSI-u:\n${rendered}`,
      );
    } finally {
      setKittyProtocolActive(false);
    }
  });

  test('mid-message trigger works under xterm modifyOtherKeys encoding', async () => {
    // Regression: pi-tui's Editor decodes modifyOtherKeys printables
    // (ESC[27;1;<cp>~), but the trigger guard only recognized Kitty CSI-u, so
    // the menu never appeared even though the text was inserted.
    const tui = new TUI(new FakeTerminal());
    const editor = new MakaSkillHighlightEditor(tui, editorTheme(), { paddingX: 1 });
    editor.setAutocompleteProvider(new MakaAutocompleteProvider(tmpdir(), commands, listSkills));
    for (const ch of 'see /') editor.handleInput(`\x1b[27;1;${ch.codePointAt(0)}~`);
    await waitFor(() => editor.isShowingAutocomplete());
    const rendered = editor.render(80).join('\n');
    assert.ok(
      rendered.includes('/skill:weekly-report'),
      `expected skill completion under modifyOtherKeys:\n${rendered}`,
    );
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

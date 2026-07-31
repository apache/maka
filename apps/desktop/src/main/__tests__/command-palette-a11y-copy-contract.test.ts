import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('Command palette accessibility and visible copy', () => {
  it('delegates dialog, search, keyboard, focus, and selection to Astryx', async () => {
    const source = await readRepo('apps/desktop/src/renderer/command-palette.tsx');

    assert.match(source, /CommandPalette as AstryxCommandPalette/);
    assert.match(source, /<AstryxCommandPalette[\s\S]*searchSource=\{searchSource\}/);
    assert.match(source, /<CommandPaletteInput[\s\S]*label=\{copy\.searchLabel\}/);
    assert.match(source, /<CommandPaletteFooter>/);
    assert.doesNotMatch(source, /@base-ui\/react\/autocomplete/);
    assert.doesNotMatch(source, /<input\b|<button\b|onKeyDown=|querySelector\(/);
  });

  it('maps the product command catalog into the Astryx search source', async () => {
    const source = await readRepo('apps/desktop/src/renderer/command-palette.tsx');

    assert.match(source, /props\.commands\.map\(\(command\) => \(\{/);
    assert.match(source, /bootstrap: \(\) => items/);
    assert.match(source, /if \(fuzzy\(normalized, command\.label\)\) return true/);
    assert.match(source, /command\.keywords\?\.some/);
    assert.match(source, /onValueChange=\{commit\}/);
    assert.doesNotMatch(source, /contentSearch|useThreadSearch/);
  });

  it('localizes public input, empty-state, and footer copy', async () => {
    const [source, catalog] = await Promise.all([
      readRepo('apps/desktop/src/renderer/command-palette.tsx'),
      readRepo('apps/desktop/src/renderer/locales/shell-copy.ts'),
    ]);

    for (const key of [
      'placeholder',
      'searchLabel',
      'emptyTitle',
      'emptyDescription',
      'selectHint',
      'runHint',
      'closeHint',
    ]) {
      assert.match(source, new RegExp(`copy\\.${key}`));
    }
    assert.match(catalog, /label: '新建对话',[\s\S]*?hint: '开始新的会话'/);
    assert.match(catalog, /label: 'New conversation',[\s\S]*?hint: 'Start a new conversation'/);
  });

  it('has an e2e-fixture opener for the command palette', async () => {
    const [main, core, fixture] = await Promise.all([
      readRendererShellCombinedSource(),
      readRepo('packages/core/src/e2e-fixture.ts'),
      readRepo('apps/desktop/src/main/e2e-fixture.ts'),
    ]);

    assert.match(core, /\| 'command-palette-open'/);
    assert.match(core, /paletteOpen\?: boolean;/);
    assert.match(fixture, /case 'command-palette-open':[\s\S]*paletteOpen: true/);
    assert.match(main, /if \(state\.paletteOpen\) \{\s*openPalette\(\);\s*\}/);
  });

  it('closes through controlled Astryx state before running a command once', async () => {
    const source = await readRepo('apps/desktop/src/renderer/command-palette.tsx');

    assert.match(source, /const pendingCommandRef = useRef<Command \| null>\(null\)/);
    assert.match(
      source,
      /function commit\(commandId: string\) \{[\s\S]*if \(!command \|\| pendingCommandRef\.current\) return;[\s\S]*pendingCommandRef\.current = command;[\s\S]*props\.onOpenChange\(false\);/,
    );
    assert.doesNotMatch(source, /command\.disabled/);
    assert.match(
      source,
      /if \(props\.isOpen\) return;[\s\S]*const command = pendingCommandRef\.current;[\s\S]*pendingCommandRef\.current = null;[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*Promise\.resolve\(command\.run\(\)\)\.catch/,
    );
  });

  it('contains command action failures inside the palette boundary', async () => {
    const source = await readRepo('apps/desktop/src/renderer/command-palette.tsx');
    assert.match(source, /Promise\.resolve\(command\.run\(\)\)\.catch\(\(\) => undefined\)/);
  });
});

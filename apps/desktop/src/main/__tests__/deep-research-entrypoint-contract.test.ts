import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('deep research command entrypoint contract', () => {
  it('command palette exposes a normal action for starting deep research', async () => {
    const src = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/command-palette-commands.ts'), 'utf8');
    const catalog = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/locales/shell-copy.ts'), 'utf8');

    assert.match(src, /onStartDeepResearch\?\(\): Promise<void> \| void/);
    assert.match(src, /id:\s*'action:new-deep-research'/);
    assert.match(src, /staticCopy\('action:new-deep-research'\)/);
    assert.match(catalog, /label: '新建深度研究'/);
    assert.match(catalog, /label: 'New deep research'/);
    assert.match(src, /run:\s*\(\)\s*=>\s*args\.onStartDeepResearch!\(\)/);
  });

  it('main wires the command through the one session-creation path', async () => {
    const src = await readRendererShellCombinedSource();

    assert.match(
      src,
      /onStartDeepResearch:\s*async \(\)\s*=>\s*\{[\s\S]*await startModeSession\('deep_research'\);[\s\S]*\}/,
      'deep research palette action must await the mode-session start so the palette sees the pending promise',
    );
    // #1433: the renderer names the intent; main derives the boundary. A
    // renderer that spelled out `permissionMode: 'explore'` here would be
    // asserting a security boundary it does not own.
    assert.match(
      src,
      /window\.maka\.sessions\.create\(\{ mode \}\)/,
      'the mode-session start must go through sessions:create with the mode alone',
    );
    assert.doesNotMatch(
      src,
      /window\.maka\.quickChat/,
      'quickChat:start was merged into sessions:create',
    );
  });
});

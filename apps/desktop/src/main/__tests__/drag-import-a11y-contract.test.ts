import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('drag import accessibility status', () => {
  it('announces active file drag affordances in the composer', async () => {
    const [composer, conversationCopy] = await Promise.all([
      readRepo('packages/ui/src/composer.tsx'),
      readRepo('packages/ui/src/conversation-copy.ts'),
    ]);

    assert.match(composer, /dragActive && \(\s*<span className="maka-visually-hidden" role="status" aria-live="polite">\s*\{copy\.dropToImport\}\s*<\/span>\s*\)/);
    assert.match(conversationCopy, /dropToImport: '松开以导入文件内容'/);
    assert.match(conversationCopy, /dropToImport: 'Drop to import file contents'/);
  });

  it('keeps the hidden live status accessible instead of display-none', async () => {
    const styles = await readRendererContractCss();
    const match = styles.match(/\.maka-visually-hidden\s*{(?<body>[\s\S]*?)}/);
    assert.ok(match?.groups?.body, 'styles.css must define .maka-visually-hidden');
    assert.match(match.groups.body, /position:\s*absolute\s*!important;/);
    assert.match(match.groups.body, /clip:\s*rect\(0 0 0 0\)\s*!important;/);
    assert.doesNotMatch(match.groups.body, /display:\\s*none/i);
    assert.doesNotMatch(match.groups.body, /visibility:\\s*hidden/i);
  });
});

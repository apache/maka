import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

function extractChannels(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).sort();
}

describe('IPC surface contract', () => {
  it('keeps main handlers paired with preload invocations', async () => {
    const [main, preload] = await Promise.all([
      readMainProcessCombinedSource(),
      readFile(join(repoRoot, 'apps/desktop/src/preload/preload.ts'), 'utf8'),
    ]);
    const mainChannels = new Set(
      extractChannels(main, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g),
    );
    const preloadChannels = new Set(
      extractChannels(preload, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g),
    );
    assert.deepEqual(
      [...preloadChannels].filter((channel) => !mainChannels.has(channel)),
      [],
      'every preload invoke channel must have a main handler',
    );
    assert.deepEqual(
      [...mainChannels].filter((channel) => !preloadChannels.has(channel)),
      [],
      'main process must not expose stale invoke handlers outside the preload bridge',
    );
  });
});

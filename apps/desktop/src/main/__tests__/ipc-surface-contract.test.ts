import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const desktopRoot = process.cwd().endsWith(join('apps', 'desktop'))
  ? process.cwd()
  : join(process.cwd(), 'apps', 'desktop');

async function findTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        return entry.name === '__tests__' || entry.name === 'dist'
          ? []
          : findTypeScriptFiles(join(directory, entry.name));
      }
      return entry.name.endsWith('.ts') ? [join(directory, entry.name)] : [];
    }),
  );
  return files.flat();
}

function extractChannels(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

describe('IPC surface contract', () => {
  it('keeps main handlers and preload invocations in parity', async () => {
    const mainFiles = await findTypeScriptFiles(join(desktopRoot, 'src', 'main'));
    const [mainSources, preloadSource] = await Promise.all([
      Promise.all(mainFiles.map((file) => readFile(file, 'utf8'))),
      readFile(join(desktopRoot, 'src', 'preload', 'preload.ts'), 'utf8'),
    ]);
    const mainChannels = extractChannels(
      mainSources.join('\n'),
      /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g,
    );
    const preloadChannels = extractChannels(
      preloadSource,
      /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g,
    );

    assert.deepEqual([...mainChannels].sort(), [...preloadChannels].sort());
  });
});

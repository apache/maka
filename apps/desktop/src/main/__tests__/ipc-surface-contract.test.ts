import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const desktopRoot = process.cwd().endsWith(join('apps', 'desktop'))
  ? process.cwd()
  : join(process.cwd(), 'apps', 'desktop');

// Temporary Main-only Usage/Pricing routes; coordinate Host replacement in #2010 and #2015.
const RETAINED_MAIN_ONLY_CHANNELS = new Set([
  'usage:summary',
  'usage:buckets',
  'usage:logs',
  'usage:pricing:list',
  'usage:pricing:put',
  'usage:pricing:reset',
]);

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
  it('keeps preload parity except for the retained Usage authority handlers', async () => {
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

    const retainedMainChannels = new Set(
      [...mainChannels].filter((channel) => RETAINED_MAIN_ONLY_CHANNELS.has(channel)),
    );
    const exposedMainChannels = new Set(
      [...mainChannels].filter((channel) => !RETAINED_MAIN_ONLY_CHANNELS.has(channel)),
    );

    assert.deepEqual(
      [...retainedMainChannels].sort(),
      [...RETAINED_MAIN_ONLY_CHANNELS].sort(),
      'every approved Main-only Usage handler must remain registered',
    );
    assert.deepEqual(
      [...exposedMainChannels].sort(),
      [...preloadChannels].sort(),
      'all other Main handlers and preload invocations must stay in exact parity',
    );
  });
});

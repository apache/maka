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

// Channels deliberately registered in main with no preload consumer.
// usage:* is the #1596 Usage/Pricing authority surface: per the #1982
// decision it stays main-side until the #2010 M4 client adapter exposes a
// narrow renderer interface (pricing.query / pricing.mutate).
const MAIN_ONLY_CHANNELS = [
  'usage:summary',
  'usage:buckets',
  'usage:logs',
  'usage:pricing:list',
  'usage:pricing:put',
  'usage:pricing:reset',
];

describe('IPC surface contract', () => {
  it('keeps main handlers and preload invocations in parity', async () => {
    const mainFiles = await findTypeScriptFiles(join(desktopRoot, 'src', 'main'));
    const [mainSources, preloadSource] = await Promise.all([
      Promise.all(mainFiles.map((file) => readFile(file, 'utf8'))),
      readFile(join(desktopRoot, 'src', 'preload', 'preload.ts'), 'utf8'),
    ]);
    const mainChannels = extractChannels(
      mainSources.join('\n'),
      /(?:\bipcMain|\b[A-Za-z_$][\w$]*\.ipcMain|\btargetIpc|\btarget)\.handle\(\s*['"]([^'"]+)['"]/g,
    );
    const preloadChannels = extractChannels(
      preloadSource,
      /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g,
    );

    for (const channel of MAIN_ONLY_CHANNELS) {
      assert.ok(
        mainChannels.has(channel),
        `main-only channel ${channel} is no longer registered — remove it from MAIN_ONLY_CHANNELS`,
      );
      assert.ok(
        !preloadChannels.has(channel),
        `channel ${channel} gained a preload consumer — remove it from MAIN_ONLY_CHANNELS`,
      );
      mainChannels.delete(channel);
    }

    assert.deepEqual([...mainChannels].sort(), [...preloadChannels].sort());
  });
});

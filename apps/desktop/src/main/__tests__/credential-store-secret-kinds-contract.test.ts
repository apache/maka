import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { CredentialKind, CredentialStore } from '../credential-store.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith(join('apps', 'desktop'))
  ? resolve(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(relativePath: string): Promise<string> {
  if (relativePath === 'apps/desktop/src/main/main.ts') return readMainProcessCombinedSource();
  return readFile(join(repoRoot, relativePath), 'utf8');
}

// Compile-time guard: the desktop entrypoint still consumes the shared
// CredentialStore contract (re-exported from @maka/storage). The store
// implementation and its kind/slug invariants — legacy stored-key names,
// no raw secret in key names, fail-closed reads — are now tested
// behaviourally in packages/storage/src/__tests__/credential-store.test.ts.
const credentialKinds: CredentialKind[] = [
  'api_key',
  'oauth_token',
  'bot_token',
  'app_secret',
  'proxy_password',
  'tavily_api_key',
];
const secretReader = null as unknown as Pick<CredentialStore, 'getSecret'>;
void credentialKinds;
void secretReader;

describe('credential store migration off safeStorage (#32)', () => {
  it('uses the pure-Node @maka/storage backend as the live store, not a safeStorage store', async () => {
    const source = await readRepo('apps/desktop/src/main/credential-store.ts');
    // Contract + implementation are re-exported from the shared package.
    assert.match(source, /from '@maka\/storage'/);
    assert.match(source, /createFileCredentialStore/);
    // No live get/set store class remains in the desktop file — safeStorage
    // is used ONLY by the one-time importer below.
    assert.doesNotMatch(source, /class \w*CredentialStore/);

    const main = await readRepo('apps/desktop/src/main/main.ts');
    assert.match(main, /createFileCredentialStore\(workspaceRoot\)/);
    assert.doesNotMatch(main, /createSafeStorageCredentialStore/);
  });

  it('runs the migration before any credential use, non-fatally', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    // Inside the whenReady handler, in a try/catch so a migration failure
    // doesn't crash startup (later reads fail closed with guidance).
    assert.match(main, /try \{\s*await migrateLegacyCredentials\(workspaceRoot, safeStorage\);\s*\} catch/);
  });

  it('keeps renderer-facing settings masked and does not read bot/global secrets in main', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const helpers = await readRepo('apps/desktop/src/main/settings-ipc-helpers.ts');

    assert.match(main, /ipcMain\.handle\('settings:get', async \(\) => maskAppSettings\(await settingsStore\.get\(\)\)\);/);
    assert.doesNotMatch(main, /credentialStore\.(getBotToken|getBotAppSecret|getProxyPassword|getTavilyApiKey)/);
    assert.match(helpers, /password: shouldReveal\(revealPatch\.network\?\.proxy\?\.password\)/);
    assert.match(helpers, /token: shouldReveal\(revealPatch\.botChat\?\.channels\?\.\[provider as BotProvider\]\?\.token\)/);
    assert.match(helpers, /appSecret: shouldReveal\(revealPatch\.botChat\?\.channels\?\.\[provider as BotProvider\]\?\.appSecret\)/);
    assert.match(helpers, /apiKey: maskSensitive\(settings\.webSearch\.providers\.tavily\.apiKey\) \?\? ''/);
  });
});

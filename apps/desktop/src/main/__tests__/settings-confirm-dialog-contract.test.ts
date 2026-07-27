import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readProviderSettingsCombinedSource } from './provider-contract-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

describe('Settings destructive confirm contract', () => {
  it('does not use native confirm dialogs in Settings renderer flows', async () => {
    const [settings, providers] = await Promise.all([
      readSettingsCombinedSource(),
      readProviderSettingsCombinedSource(),
    ]);
    const source = `${settings}\n${providers}`;

    assert.doesNotMatch(
      source,
      /(^|[^\w.])confirm\s*\(/,
      'Settings flows must use toast.confirm instead of the native blocking confirm() dialog',
    );
    assert.doesNotMatch(
      source,
      /window\.confirm\s*\(/,
      'Settings flows must not call window.confirm directly',
    );
  });

  it('routes OAuth, provider, memory restore, and WeChat destructive actions through toast.confirm', async () => {
    const [settings, providers, loginFlowHook] = await Promise.all([
      readSettingsCombinedSource(),
      readProviderSettingsCombinedSource(),
      // The browser-loopback logout confirm moved into the shared login-flow
      // hook when SubscriptionLoginModal was thinned onto useOAuthLoginFlow.
      readRepo('apps/desktop/src/renderer/settings/use-oauth-login-flow.ts'),
    ]);
    const providerSources = `${providers}\n${loginFlowHook}`;

    assert.match(loginFlowHook, /title: copy\.logoutTitle\(display\.name\)/);
    assert.match(providers, /title: copy\.deleteProviderTitle\(connection\.name(?: \|\| connection\.slug)?\)/);
    assert.match(providers, /title: copy\.logoutTitle/);
    assert.match(loginFlowHook, /destructive:\s*true/, 'shared OAuth logout confirm must use destructive styling');

    assert.match(settings, /title: copy\.text\.restoreLatestTitle/);
    assert.match(settings, /title: copy\.text\.restoreCandidateTitle/);
    assert.match(settings, /copy\.disconnectTitle/);
    assert.match(settings, /copy\.disconnectWhatsappTitle/);

    assert.match(providers, /destructive:\s*true/, 'provider destructive confirms must use destructive styling');
    assert.match(settings, /destructive:\s*true/, 'settings destructive confirms must use destructive styling');
  });
});

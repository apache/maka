/**
 * Unit tests for the authoritative OAuth token persistence layer
 * (#1125): CredentialStore-backed save/load/delete. Exercised against
 * the real pure-Node FileCredentialStore in a tmpdir so the on-disk
 * contract is covered end to end.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { resolveOAuthSubscriptionTokens } from '@maka/runtime';
import { createFileCredentialStore } from '@maka/storage';
import {
  deleteSharedOAuthTokens,
  loadSharedOAuthTokens,
  saveSharedOAuthTokens,
} from '../oauth/shared-credential-bridge.js';

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_at: 1_800_000_000_000,
  account_uuid: 'uuid-1',
};

const tempRoots: string[] = [];
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-oauth-bridge-'));
  tempRoots.push(root);
  return root;
}
after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('shared OAuth token persistence (store authority)', () => {
  it('round-trips tokens through the credential store', async () => {
    const store = createFileCredentialStore(await makeWorkspace());
    await saveSharedOAuthTokens(store, 'claude-subscription', TOKENS);
    const result = await loadSharedOAuthTokens(store, 'claude-subscription');
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.tokens, TOKENS);
  });

  it('makes a desktop-written token immediately readable by a pure-Node runtime surface', async () => {
    const workspaceRoot = await makeWorkspace();
    const desktopStore = createFileCredentialStore(workspaceRoot);
    await saveSharedOAuthTokens(desktopStore, 'codex-subscription', TOKENS);

    const runtimeStore = createFileCredentialStore(workspaceRoot);
    const resolved = await resolveOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: 'codex-subscription',
      credentialStore: runtimeStore,
      now: () => TOKENS.expires_at - 3_600_000,
      fetchFn: async () => assert.fail('a fresh shared token must not use the network'),
    });

    assert.deepEqual(resolved, TOKENS);
  });

  it('reports missing tokens as missing', async () => {
    const store = createFileCredentialStore(await makeWorkspace());
    assert.deepEqual(await loadSharedOAuthTokens(store, 'claude-subscription'), { status: 'missing' });
  });

  it('save propagates store failures instead of swallowing them', async () => {
    await assert.rejects(
      saveSharedOAuthTokens(
        { setSecret: async () => { throw new Error('store down'); } },
        'claude-subscription',
        TOKENS,
      ),
      /store down/,
    );
  });

  it('load propagates store read failures (fail closed, not logged out)', async () => {
    const workspaceRoot = await makeWorkspace();
    await writeFile(join(workspaceRoot, 'credentials.json'), '{"version":999,"values":{}}');
    const store = createFileCredentialStore(workspaceRoot);
    await assert.rejects(loadSharedOAuthTokens(store, 'claude-subscription'), /schema version/);
  });

  it('keeps an unparseable entry intact and reports corrupt (reads never destroy secrets)', async () => {
    const store = createFileCredentialStore(await makeWorkspace());
    await store.setSecret('claude-subscription', 'oauth_token', 'not-a-token-payload');
    assert.deepEqual(await loadSharedOAuthTokens(store, 'claude-subscription'), { status: 'corrupt' });
    assert.equal(await store.getSecret('claude-subscription', 'oauth_token'), 'not-a-token-payload');
    // A fresh login overwrites the corrupt entry — no delete needed to unstick.
    await saveSharedOAuthTokens(store, 'claude-subscription', TOKENS);
    assert.equal((await loadSharedOAuthTokens(store, 'claude-subscription')).status, 'ok');
  });

  it('delete removes the entry and leaves other kinds intact', async () => {
    const store = createFileCredentialStore(await makeWorkspace());
    await store.setSecret('claude-subscription', 'api_key', 'sk-keep');
    await saveSharedOAuthTokens(store, 'claude-subscription', TOKENS);
    await deleteSharedOAuthTokens(store, 'claude-subscription');
    assert.equal(await store.getSecret('claude-subscription', 'oauth_token'), null);
    assert.equal(await store.getSecret('claude-subscription', 'api_key'), 'sk-keep');
  });
});

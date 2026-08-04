import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createFileCredentialStore } from '../credential-store.js';
import { retireCursorSubscriptionCredentials } from '../oauth/cursor-subscription-retirement.js';

describe('Cursor subscription credential retirement', () => {
  it('removes both Cursor stores without touching other credentials and is safe to rerun', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-cursor-retirement-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const userDataDir = join(root, 'user-data');
    await mkdir(userDataDir);
    const legacyTokenPath = join(userDataDir, '.cursor_subscription_token');
    await writeFile(legacyTokenPath, 'legacy-token');

    const credentialStore = createFileCredentialStore(join(root, 'workspace'));
    await credentialStore.setSecret('cursor-subscription', 'oauth_token', 'cursor-oauth');
    await credentialStore.setSecret('cursor-subscription', 'api_key', 'cursor-api-key');
    await credentialStore.setSecret('openai', 'oauth_token', 'openai-oauth');
    await credentialStore.setSecret('anthropic', 'api_key', 'anthropic-api-key');

    await retireCursorSubscriptionCredentials({ userDataDir, credentialStore });
    await assert.rejects(stat(legacyTokenPath), { code: 'ENOENT' });
    assert.equal(await credentialStore.getSecret('cursor-subscription', 'oauth_token'), null);
    assert.equal(
      await credentialStore.getSecret('cursor-subscription', 'api_key'),
      'cursor-api-key',
    );
    assert.equal(await credentialStore.getSecret('openai', 'oauth_token'), 'openai-oauth');
    assert.equal(await credentialStore.getSecret('anthropic', 'api_key'), 'anthropic-api-key');

    await retireCursorSubscriptionCredentials({ userDataDir, credentialStore });
    await assert.rejects(stat(legacyTokenPath), { code: 'ENOENT' });
    assert.equal(
      await credentialStore.getSecret('cursor-subscription', 'api_key'),
      'cursor-api-key',
    );
    assert.equal(await credentialStore.getSecret('openai', 'oauth_token'), 'openai-oauth');
    assert.equal(await credentialStore.getSecret('anthropic', 'api_key'), 'anthropic-api-key');
  });

  it('attempts the shared-store cleanup when the legacy file cannot be removed', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-cursor-retirement-failure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const legacyTokenPath = join(root, '.cursor_subscription_token');
    await mkdir(legacyTokenPath);
    const deleted: string[] = [];

    await assert.rejects(
      retireCursorSubscriptionCredentials({
        userDataDir: root,
        credentialStore: {
          deleteSecret: async (slug, kind) => {
            deleted.push(`${slug}:${String(kind)}`);
          },
        },
      }),
      AggregateError,
    );
    assert.deepEqual(deleted, ['cursor-subscription:oauth_token']);
  });

  it('removes the legacy file when the shared store fails and retries on the next run', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-cursor-retirement-retry-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const legacyTokenPath = join(root, '.cursor_subscription_token');
    await writeFile(legacyTokenPath, 'legacy-token');
    let deleteAttempts = 0;
    const deps = {
      userDataDir: root,
      credentialStore: {
        deleteSecret: async () => {
          deleteAttempts += 1;
          if (deleteAttempts === 1) throw new Error('credential store unavailable');
        },
      },
    };

    await assert.rejects(retireCursorSubscriptionCredentials(deps), AggregateError);
    await assert.rejects(stat(legacyTokenPath), { code: 'ENOENT' });

    await retireCursorSubscriptionCredentials(deps);
    assert.equal(deleteAttempts, 2);
  });
});

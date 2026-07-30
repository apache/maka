import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileCredentialStore } from '@maka/storage';
import { createCodexOAuthHarnessCredentialBinding } from '../codex-oauth-harness.js';

test('Codex OAuth broker resolves the current host authority for every request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-codex-oauth-resolver-test-'));
  try {
    const store = createFileCredentialStore(root);
    const accountId = 'acct-shared';
    const firstAccessToken = jwt(accountId, 'first');
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: firstAccessToken,
        refresh_token: 'refresh-first',
        expires_at: Date.now() + 86_400_000,
        account_id: accountId,
      }),
    );
    const binding = await createCodexOAuthHarnessCredentialBinding({
      credentialsRoot: root,
      connectionSlug: 'codex-subscription',
    });
    const { resolveProviderCredential } = binding;
    assert.deepEqual(binding.credentialIdentity, {
      connectionSlug: 'codex-subscription',
      accountIdHash: 'sha256:4e6909117f1a98c24693367a0cd86e4f3295e7850d8b6ebf97a3a8eae24e3ee9',
    });

    const first = await resolveProviderCredential();
    const secondAccessToken = jwt(accountId, 'second');
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: secondAccessToken,
        refresh_token: 'refresh-second',
        expires_at: Date.now() + 86_400_000,
        account_id: accountId,
      }),
    );
    const second = await resolveProviderCredential();

    assert.equal(first.value, firstAccessToken);
    assert.equal(second.value, secondAccessToken);
    assert.deepEqual(first.headers, { 'ChatGPT-Account-Id': accountId });
    assert.deepEqual(second.headers, { 'ChatGPT-Account-Id': accountId });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex OAuth broker rejects an account change during a run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-codex-oauth-account-test-'));
  try {
    const store = createFileCredentialStore(root);
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: jwt('acct-first', 'first'),
        refresh_token: 'refresh-first',
        expires_at: Date.now() + 86_400_000,
        account_id: 'acct-first',
      }),
    );
    const { resolveProviderCredential } = await createCodexOAuthHarnessCredentialBinding({
      credentialsRoot: root,
      connectionSlug: 'codex-subscription',
    });

    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: jwt('acct-second', 'second'),
        refresh_token: 'refresh-second',
        expires_at: Date.now() + 86_400_000,
        account_id: 'acct-second',
      }),
    );

    await assert.rejects(resolveProviderCredential(), /Codex OAuth account changed during the run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex OAuth broker refreshes and persists authority across a long run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-codex-oauth-refresh-test-'));
  try {
    const store = createFileCredentialStore(root);
    const accountId = 'acct-shared';
    let now = 1_000_000;
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: jwt(accountId, 'expired'),
        refresh_token: 'refresh-0',
        expires_at: now - 1,
        account_id: accountId,
      }),
    );
    let refreshCount = 0;
    const { resolveProviderCredential } = await createCodexOAuthHarnessCredentialBinding({
      credentialsRoot: root,
      connectionSlug: 'codex-subscription',
      now: () => now,
      fetchFn: async () => {
        refreshCount += 1;
        return new Response(
          JSON.stringify({
            access_token: jwt(accountId, `refreshed-${refreshCount}`),
            refresh_token: `refresh-${refreshCount}`,
            expires_in: 3_600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    assert.equal((await resolveProviderCredential()).value, jwt(accountId, 'refreshed-1'));
    now += 3_600_001;
    assert.equal((await resolveProviderCredential()).value, jwt(accountId, 'refreshed-2'));
    assert.equal(refreshCount, 2);
    const persisted = JSON.parse(
      (await store.getSecret('codex-subscription', 'oauth_token')) ?? 'null',
    );
    assert.equal(persisted.refresh_token, 'refresh-2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex OAuth broker cancels an in-flight refresh with the request signal', {
  timeout: 5_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-codex-oauth-cancel-test-'));
  let releaseRefresh = () => {};
  let resolution: Promise<unknown> | undefined;
  let rejectionTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const store = createFileCredentialStore(root);
    const accountId = 'acct-shared';
    let now = 1_000_000;
    await store.setSecret(
      'codex-subscription',
      'oauth_token',
      JSON.stringify({
        access_token: jwt(accountId, 'current'),
        refresh_token: 'refresh-current',
        expires_at: now + 3_600_000,
        account_id: accountId,
      }),
    );
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const { resolveProviderCredential } = await createCodexOAuthHarnessCredentialBinding({
      credentialsRoot: root,
      connectionSlug: 'codex-subscription',
      now: () => now,
      fetchFn: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        markRefreshStarted();
        return await new Promise<Response>((resolve, reject) => {
          releaseRefresh = () =>
            resolve(
              new Response(
                JSON.stringify({
                  access_token: jwt(accountId, 'refreshed'),
                  refresh_token: 'refresh-next',
                  expires_in: 3_600,
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              ),
            );
          observedSignal?.addEventListener(
            'abort',
            () => {
              reject(observedSignal?.reason);
            },
            { once: true },
          );
        });
      },
    });
    now += 3_600_001;
    const controller = new AbortController();
    resolution = resolveProviderCredential(controller.signal);

    await refreshStarted;
    assert.equal(observedSignal, controller.signal);
    controller.abort();
    await assert.rejects(
      Promise.race([
        resolution,
        new Promise((_, reject) => {
          rejectionTimeout = setTimeout(
            () => reject(new Error('credential resolution did not observe cancellation')),
            250,
          );
        }),
      ]),
      /credentials are unavailable/,
    );
  } finally {
    if (rejectionTimeout) clearTimeout(rejectionTimeout);
    releaseRefresh();
    await resolution?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function jwt(accountId: string, suffix: string): string {
  const encoded = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId }, suffix }),
  ).toString('base64url');
  return `header.${encoded}.signature`;
}

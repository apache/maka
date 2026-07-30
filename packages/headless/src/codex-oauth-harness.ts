import { createHash } from 'node:crypto';
import { extractCodexAccountId, resolveOAuthSubscriptionTokens } from '@maka/runtime';
import { createFileCredentialStore } from '@maka/storage';
import type { ProviderUpstreamCredentialResolver } from './provider-auth-proxy.js';

export interface CodexOAuthHarnessCredentialBindingInput {
  credentialsRoot: string;
  connectionSlug: string;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export interface CodexOAuthHarnessCredentialBinding {
  credentialIdentity: {
    connectionSlug: string;
    accountIdHash: string;
  };
  resolveProviderCredential: ProviderUpstreamCredentialResolver;
}

export async function createCodexOAuthHarnessCredentialBinding(
  input: CodexOAuthHarnessCredentialBindingInput,
): Promise<CodexOAuthHarnessCredentialBinding> {
  const credentialStore = createFileCredentialStore(input.credentialsRoot);
  const resolveTokens = async (signal?: AbortSignal) => {
    const signalBoundFetch: typeof fetch | undefined = signal
      ? (resource, init) =>
          (input.fetchFn ?? fetch)(resource, {
            ...init,
            signal,
          })
      : input.fetchFn;
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: input.connectionSlug,
      credentialStore,
      ...(input.now ? { now: input.now } : {}),
      ...(signalBoundFetch ? { fetchFn: signalBoundFetch } : {}),
    });
    if (!tokens) throw new Error('Maka Codex OAuth credentials are unavailable');
    return tokens;
  };
  const initialTokens = await resolveTokens();
  const expectedAccountId = extractCodexAccountId(initialTokens.access_token);
  if (!expectedAccountId) throw new Error('Maka Codex OAuth credential has no account identity');
  const resolveCredential: ProviderUpstreamCredentialResolver = async (signal) => {
    const tokens = await resolveTokens(signal);
    const accountId = extractCodexAccountId(tokens.access_token);
    if (accountId !== expectedAccountId) {
      throw new Error('Codex OAuth account changed during the run');
    }
    return {
      value: tokens.access_token,
      headers: { 'ChatGPT-Account-Id': accountId },
    };
  };
  return {
    credentialIdentity: {
      connectionSlug: input.connectionSlug,
      accountIdHash: `sha256:${createHash('sha256').update(expectedAccountId!).digest('hex')}`,
    },
    resolveProviderCredential: resolveCredential,
  };
}

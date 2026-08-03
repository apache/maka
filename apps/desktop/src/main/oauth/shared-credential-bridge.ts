/** OAuth token persistence through the shared CredentialStore authority. */
import {
  parseOAuthSubscriptionTokens,
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '@maka/runtime';
import type { CredentialStore } from '@maka/storage';

export type SharedOAuthCredentialStore = Pick<
  CredentialStore,
  'getSecret' | 'setSecret' | 'deleteSecret' | 'compareAndSetSecret'
>;

export type SharedOAuthTokensReadResult =
  | { status: 'ok'; tokens: OAuthSubscriptionTokens }
  | { status: 'missing' }
  | { status: 'corrupt' };

export async function saveSharedOAuthTokens(
  store: Pick<CredentialStore, 'setSecret'>,
  slug: string,
  tokens: OAuthSubscriptionTokens,
): Promise<void> {
  await store.setSecret(slug, 'oauth_token', serializeOAuthSubscriptionTokens(tokens));
}

export async function loadSharedOAuthTokens(
  store: SharedOAuthCredentialStore,
  slug: string,
): Promise<SharedOAuthTokensReadResult> {
  const raw = await store.getSecret(slug, 'oauth_token');
  if (raw === null) return { status: 'missing' };
  const tokens = parseOAuthSubscriptionTokens(raw);
  return tokens ? { status: 'ok', tokens } : { status: 'corrupt' };
}

export async function deleteSharedOAuthTokens(
  store: Pick<CredentialStore, 'deleteSecret'>,
  slug: string,
): Promise<void> {
  await store.deleteSecret(slug, 'oauth_token');
}

import type { LlmConnection } from '@maka/core';
import type { ConnectionStore, CredentialStore } from '@maka/storage';

interface DeleteConnectionWithCredentialDeps {
  connectionStore: Pick<ConnectionStore, 'get' | 'delete'>;
  credentialStore: Pick<CredentialStore, 'deleteSecret'>;
  /**
   * Logs out account-managed OAuth connections before their catalog row is
   * removed. Without this step the next connection-list read materializes the
   * still-authenticated account again, making deletion appear to do nothing.
   */
  disconnectManagedOAuthConnection(connection: LlmConnection): Promise<void>;
}

export async function deleteConnectionWithCredential(
  deps: DeleteConnectionWithCredentialDeps,
  slug: string,
): Promise<void> {
  const connection = await deps.connectionStore.get(slug);
  if (connection) {
    await deps.disconnectManagedOAuthConnection(connection);
  }
  await deps.connectionStore.delete(slug);
  await deps.credentialStore.deleteSecret(slug);
}

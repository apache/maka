import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialStore } from '@maka/storage';

const CURSOR_SUBSCRIPTION_SLUG = 'cursor-subscription';
const LEGACY_CURSOR_TOKEN_FILE = '.cursor_subscription_token';

interface CursorSubscriptionRetirementDeps {
  userDataDir: string;
  credentialStore: Pick<CredentialStore, 'deleteSecret'>;
}

/**
 * Remove the legacy file and OAuth entry owned by the retired Cursor
 * subscription surface.
 *
 * This deliberately never reads or migrates either source. Both removals are
 * attempted independently so a failure in one store cannot strand the other,
 * and rerunning the cleanup is safe after a partial or completed attempt.
 */
export async function retireCursorSubscriptionCredentials(
  deps: CursorSubscriptionRetirementDeps,
): Promise<void> {
  const legacyTokenPath = join(deps.userDataDir, LEGACY_CURSOR_TOKEN_FILE);
  const results = await Promise.allSettled([
    unlinkIfPresent(legacyTokenPath),
    deps.credentialStore.deleteSecret(CURSOR_SUBSCRIPTION_SLUG, 'oauth_token'),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Cursor subscription credential retirement failed');
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

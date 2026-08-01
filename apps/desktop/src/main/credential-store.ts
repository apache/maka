import { join } from 'node:path';
import { createFileCredentialStore, migrateLegacyCredentialFile } from '@maka/storage';

/**
 * The slice of Electron `safeStorage` the importer needs, injected so the
 * migration can be tested without Electron — and so this module no longer
 * imports `electron` at load time. main.ts passes the real `safeStorage`.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  decryptString(encrypted: Buffer): string;
}

// The credential store and its migration are pure-Node and live in
// @maka/storage so the headless runtime can read the same file (issue #32).
// Re-exported here so existing `./credential-store.js` importers keep their path.
export type { CredentialKind, CredentialStore } from '@maka/storage';
export { CREDENTIAL_SCHEMA_VERSION, createFileCredentialStore } from '@maka/storage';

/**
 * One-time migration off Electron `safeStorage` (issue #32). Desktop-only glue:
 * it supplies the crypto — the legacy file stored each secret as
 * `base64(safeStorage.encryptString(value))`, so here we base64-decode and
 * `safeStorage.decryptString` each value — while @maka/storage owns the
 * orchestration: the shared cross-process lock, the version gate, fail-closed
 * aborts, the atomic 0600 rewrite, and the tombstone. A successful run leaves
 * the file as shared v1 plaintext-0600, which the headless `FileCredentialStore`
 * then reads.
 *
 * Scope — this migrates EVERY secret in `credentials.json`, not just API keys:
 * bot tokens, bot app secrets, the proxy password, and the Tavily key all
 * decrypt to plaintext too. That is required, not incidental —
 * the desktop abandons `safeStorage` entirely (the live store is now the
 * pure-Node `FileCredentialStore`), so any value left encrypted would become
 * permanently unreadable. The accepted at-rest posture for all of them is
 * plaintext behind 0600 (SECURITY.md / file-first, #32).
 *
 * If `safeStorage` is unavailable the migration aborts and leaves the encrypted
 * file untouched (a later run migrates once it is available). main.ts runs this
 * before any credential use, non-fatally, in `whenReady`.
 */
export function migrateLegacyCredentials(
  workspaceRoot: string,
  safeStorage: SafeStorageLike,
): Promise<void> {
  return migrateLegacyCredentialFile(join(workspaceRoot, 'credentials.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    decrypt: (storedValue) => safeStorage.decryptString(Buffer.from(storedValue, 'base64')),
  });
}

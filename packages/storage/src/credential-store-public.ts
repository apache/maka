/**
 * Published credential-store surface.
 *
 * The owning module also exports withCredentialFileLock for its own test; per
 * its doc comment the public surface stays the typed store, so the lock stays
 * package-private, exactly as the deleted barrel kept it.
 */
export { CREDENTIAL_SCHEMA_VERSION, createFileCredentialStore } from './credential-store.js';
export type { CredentialCasResult, CredentialKind, CredentialStore } from './credential-store.js';

import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import {
  reconcileConnectionAfterEnabledModelsChange,
  type LlmConnection,
} from '@maka/core/llm-connections';
import {
  type ConfigBundle,
  type ConfigCategory,
  type ConfigData,
  type ConnectionConflictStrategy,
  type CredentialKind,
  buildConfigBundle,
  planConnectionMerge,
} from '@maka/storage';
import { stripSettingsSecretsForExport } from './settings-ipc-helpers.js';

/**
 * Desktop-side orchestration for config import/export. Kept store-injected and
 * Electron-free so it is unit-testable; the IPC handlers in main.ts are thin
 * wrappers that supply the real stores + file dialogs.
 *
 * The credential category (opt-in, plaintext) is gathered by walking the
 * connection list and reading each slug's connection credentials — the
 * credential store exposes no bulk-list, so enumeration is the only path.
 */

export interface ExportedCredential {
  slug: string;
  kind: CredentialKind;
  value: string;
}

const CONNECTION_CREDENTIAL_KINDS: readonly CredentialKind[] = [
  'api_key',
  'oauth_token',
  'request_headers',
];
const VALID_CREDENTIAL_KINDS: ReadonlySet<string> = new Set<CredentialKind>([
  'api_key',
  'oauth_token',
  'request_headers',
  'bot_token',
  'app_secret',
  'proxy_password',
  'tavily_api_key',
]);

export interface ConfigTransferDeps {
  connectionStore: { list(): Promise<LlmConnection[]>; save(c: LlmConnection): Promise<LlmConnection> };
  settingsStore: { get(): Promise<AppSettings>; update(patch: UpdateAppSettingsInput): Promise<AppSettings> };
  credentialStore: {
    getSecret(slug: string, kind: CredentialKind): Promise<string | null>;
    setSecret(slug: string, kind: CredentialKind, value: string): Promise<void>;
  };
  readMemory(): Promise<string | null>;
  writeMemory(content: string): Promise<void>;
  appVersion: string;
}

export async function gatherConfigExport(
  categories: readonly ConfigCategory[],
  deps: ConfigTransferDeps,
): Promise<ConfigBundle> {
  const selected = new Set(categories);
  const data: ConfigData = {};

  const connections = selected.has('connections') || selected.has('credentials')
    ? await deps.connectionStore.list()
    : [];

  if (selected.has('connections')) {
    data.connections = connections;
  }

  if (selected.has('settings')) {
    const settings = await deps.settingsStore.get();
    // When credentials are included, settings keeps its embedded secrets
    // (proxy password, bot tokens, Tavily key); otherwise strip.
    data.settings = selected.has('credentials') ? settings : stripSettingsSecretsForExport(settings);
  }

  if (selected.has('credentials')) {
    const creds: ExportedCredential[] = [];
    for (const connection of connections) {
      for (const kind of CONNECTION_CREDENTIAL_KINDS) {
        const value = await deps.credentialStore.getSecret(connection.slug, kind);
        if (value) creds.push({ slug: connection.slug, kind, value });
      }
    }
    data.credentials = creds;
  }

  if (selected.has('memory')) {
    const memory = await deps.readMemory();
    if (memory !== null) data.memory = memory;
  }

  return buildConfigBundle({ appVersion: deps.appVersion, data });
}

export interface ConfigImportResult {
  connections?: { created: number; overwritten: number; skipped: number };
  settings?: { applied: boolean };
  credentials?: { applied: number; skipped: number };
  memory?: { applied: boolean };
}

export async function applyConfigImport(
  bundle: ConfigBundle,
  strategy: ConnectionConflictStrategy,
  deps: ConfigTransferDeps,
): Promise<ConfigImportResult> {
  const result: ConfigImportResult = {};
  // Credentials are only applied for connections actually written this import
  // (created or overwritten). A slug the user chose to skip must not have its
  // stored secret silently overwritten.
  const appliedConnectionSlugs = new Set<string>();

  if (Array.isArray(bundle.data.connections)) {
    const incoming = bundle.data.connections as LlmConnection[];
    const existing = await deps.connectionStore.list();
    const plan = planConnectionMerge(existing, incoming, strategy);
    for (const connection of [...plan.create, ...plan.overwrite]) {
      // A backup states its selection, so restoring it restores that selection.
      // `save()` is a snapshot boundary and cannot tell a stated selection from
      // an echoed one, so the caller that knows applies the rule — otherwise
      // the read-time shim merged the default back in and the import quietly
      // re-enabled a model the backup had disabled.
      const selection = connection.enabledModelIds
        ? reconcileConnectionAfterEnabledModelsChange(connection, connection.enabledModelIds)
        : null;
      await deps.connectionStore.save(selection ? { ...connection, ...selection } : connection);
      appliedConnectionSlugs.add(connection.slug);
    }
    result.connections = {
      created: plan.create.length,
      overwritten: plan.overwrite.length,
      skipped: plan.skipped.length,
    };
  }

  if (bundle.data.settings && typeof bundle.data.settings === 'object') {
    await deps.settingsStore.update(bundle.data.settings as unknown as UpdateAppSettingsInput);
    result.settings = { applied: true };
  }

  if (Array.isArray(bundle.data.credentials)) {
    let applied = 0;
    let skipped = 0;
    for (const entry of bundle.data.credentials as ExportedCredential[]) {
      const valid =
        entry &&
        typeof entry.slug === 'string' &&
        typeof entry.value === 'string' &&
        entry.value.length > 0 &&
        VALID_CREDENTIAL_KINDS.has(entry.kind);
      if (!valid) continue;
      // Only write a secret for a connection that was created or overwritten
      // in this import. Skipped (or not-imported) slugs keep their existing
      // stored secret untouched.
      if (!appliedConnectionSlugs.has(entry.slug)) {
        skipped += 1;
        continue;
      }
      await deps.credentialStore.setSecret(entry.slug, entry.kind, entry.value);
      applied += 1;
    }
    result.credentials = { applied, skipped };
  }

  if (typeof bundle.data.memory === 'string') {
    await deps.writeMemory(bundle.data.memory);
    result.memory = { applied: true };
  }

  return result;
}

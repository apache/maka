/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { UpdateAppSettingsInput } from '@maka/core/settings';
import { normalizeUiLocalePreference } from '@maka/core/ui-locale';
import {
  reconcileConnectionAfterEnabledModelsChange,
  type LlmConnection,
} from '@maka/core/llm-connections';
import { canonicalConnectionEffectiveBaseUrl } from '@maka/core/runtime-policy';
import {
  type ConfigBundle,
  type ConnectionConflictStrategy,
  planConnectionMerge,
} from '@maka/storage/config-transfer';
import { type CredentialKind } from '@maka/storage/credential-store';

/**
 * Electron-free config import orchestration. Runtime Host owns export because
 * it is the authority for connection, credential, and memory state.
 */

export interface ExportedCredential {
  slug: string;
  kind: CredentialKind;
  value: string;
  connection?: {
    providerType: LlmConnection['providerType'];
    effectiveBaseUrl: string;
  };
}

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
  settingsStore: {
    update(patch: UpdateAppSettingsInput): Promise<{ skippedCredentials: number }>;
  };
  credentialStore: {
    setSecret(entry: ExportedCredential): Promise<boolean>;
  };
  writeMemory(content: string): Promise<void>;
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
  // A connection snapshot limits credential writes to connections created or
  // overwritten by this import. Credentials-only bundles instead require an
  // existing slug whose provider and effective endpoint match the export.
  const credentialTargets = new Map<string, LlmConnection>();
  const hasConnectionSnapshot = Array.isArray(bundle.data.connections);

  if (hasConnectionSnapshot) {
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
      credentialTargets.set(connection.slug, connection);
    }
    result.connections = {
      created: plan.create.length,
      overwritten: plan.overwrite.length,
      skipped: plan.skipped.length,
    };
  } else if (
    !bundle.includedData.includes('connections') &&
    Array.isArray(bundle.data.credentials)
  ) {
    // Without a connection snapshot, the credential slug names an existing
    // connection, while its binding proves that the slug still names the same
    // credential destination. A bundle that does include connections still
    // uses the create/overwrite set above so an explicit skip cannot overwrite
    // the target's credential.
    const existing = await deps.connectionStore.list();
    for (const connection of existing) {
      credentialTargets.set(connection.slug, connection);
    }
  }

  let settingsCredentialSkips = 0;
  if (bundle.data.settings && typeof bundle.data.settings === 'object') {
    const patch = bundle.data.settings as unknown as UpdateAppSettingsInput;
    const importedPersonalization = patch.personalization as
      | (NonNullable<UpdateAppSettingsInput['personalization']> & { uiLocale?: unknown })
      | undefined;
    const applied = await deps.settingsStore.update(
      importedPersonalization && Object.hasOwn(importedPersonalization, 'uiLocale')
        ? {
            ...patch,
            personalization: {
              ...importedPersonalization,
              uiLocale: normalizeUiLocalePreference(importedPersonalization.uiLocale),
            },
          }
        : patch,
    );
    settingsCredentialSkips = applied.skippedCredentials;
    result.settings = { applied: true };
  }

  if (Array.isArray(bundle.data.credentials)) {
    let applied = 0;
    let skipped = settingsCredentialSkips;
    for (const entry of bundle.data.credentials as ExportedCredential[]) {
      const valid =
        entry &&
        typeof entry.slug === 'string' &&
        typeof entry.value === 'string' &&
        entry.value.length > 0 &&
        VALID_CREDENTIAL_KINDS.has(entry.kind);
      if (!valid) continue;
      // Unknown targets and connections explicitly skipped by a connection
      // snapshot keep their existing stored secret untouched.
      const target = credentialTargets.get(entry.slug);
      if (!target) {
        skipped += 1;
        continue;
      }
      const binding =
        entry.connection ??
        (hasConnectionSnapshot ? credentialConnectionBinding(target) : undefined);
      if (!matchesCredentialConnection(binding, target)) {
        skipped += 1;
        continue;
      }
      if (await deps.credentialStore.setSecret({ ...entry, connection: binding })) {
        applied += 1;
      } else {
        skipped += 1;
      }
    }
    result.credentials = { applied, skipped };
  } else if (settingsCredentialSkips > 0) {
    result.credentials = { applied: 0, skipped: settingsCredentialSkips };
  }

  if (typeof bundle.data.memory === 'string') {
    await deps.writeMemory(bundle.data.memory);
    result.memory = { applied: true };
  }

  return result;
}

export function matchesCredentialConnection(
  binding: ExportedCredential['connection'] | undefined,
  target: Pick<LlmConnection, 'providerType' | 'baseUrl'>,
): boolean {
  return (
    binding !== undefined &&
    binding.providerType === target.providerType &&
    canonicalEndpoint(binding.effectiveBaseUrl) === canonicalConnectionEffectiveBaseUrl(target)
  );
}

function credentialConnectionBinding(
  connection: LlmConnection,
): NonNullable<ExportedCredential['connection']> {
  return {
    providerType: connection.providerType,
    effectiveBaseUrl: canonicalConnectionEffectiveBaseUrl(connection),
  };
}

function canonicalEndpoint(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

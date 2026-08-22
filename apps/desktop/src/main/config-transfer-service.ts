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

import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import {
  reconcileConnectionAfterEnabledModelsChange,
  type LlmConnection,
} from '@maka/core/llm-connections';
import {
  type ConfigBundle,
  type ConnectionConflictStrategy,
  type CredentialKind,
  planConnectionMerge,
} from '@maka/storage';

/**
 * Electron-free config import orchestration. Runtime Host owns export because
 * it is the authority for connection, credential, and memory state.
 */

export interface ExportedCredential {
  slug: string;
  kind: CredentialKind;
  value: string;
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
  settingsStore: { update(patch: UpdateAppSettingsInput): Promise<AppSettings> };
  credentialStore: {
    setSecret(slug: string, kind: CredentialKind, value: string): Promise<void>;
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

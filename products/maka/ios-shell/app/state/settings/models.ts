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

import { tr } from '../../locale';
import type * as Runtime from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import type {
  ConnectionCredentialKind,
  ConnectionCredentialTarget,
  CredentialStatus,
  SettingsConnectionSummary,
  SettingsProvidersPage,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { credentialBasis, type SettingsRpc } from './rpc';

export const connectionBasis = ({ connectionId, revision }: ConnectionCredentialTarget) => ({
  connectionId,
  revision,
});

export async function readDefaultModel(rpc: SettingsRpc) {
  const page = await rpc.query('settings', 'connections', { kind: 'start' });
  if (page.kind !== 'ready') throw new Error(tr('Refresh and try again.'), { cause: page.kind });
  return resolveDefaultModel(rpc, page.defaultTarget);
}

export async function resolveDefaultModel(
  rpc: SettingsRpc,
  target: Runtime.ConnectionTarget | null,
) {
  if (!target) return null;
  const model = await rpc.query('settings', 'resolveModel', target);
  return model.kind === 'ready' ? model.choice : null;
}

export function modelBackend(choice: Runtime.SettingsModelChoice): Runtime.AgentBackendPreference {
  const { connectionId, modelId, serviceTier } = choice.selection;
  return { kind: 'model', connectionId, modelId, serviceTier };
}

export async function connectionCatalog(rpc: SettingsRpc) {
  const first = await rpc.query('settings', 'connections', { kind: 'start' });
  if (first.kind !== 'ready') throw new Error(tr('Refresh and try again.'), { cause: first.kind });
  const rows: SettingsConnectionSummary[] = [...first.connections];
  let offset = first.next;
  while (offset !== null) {
    const page = await rpc.query('settings', 'connections', {
      kind: 'continue',
      revision: first.revision,
      offset,
    });
    if (page.kind !== 'ready') throw new Error(tr('Refresh and try again.'), { cause: page.kind });
    rows.push(...page.connections);
    offset = page.next;
  }
  return { rows, revision: first.revision, defaultTarget: first.defaultTarget };
}

export type ConnectionCatalog = Awaited<ReturnType<typeof connectionCatalog>>;

// Picker metadata is optional: a Host can grant model reads but not catalog reads.
export async function loadModelCatalog(rpc: SettingsRpc): Promise<ConnectionCatalog | null> {
  try {
    return await connectionCatalog(rpc);
  } catch (cause) {
    console.warn('Model connection catalog unavailable', cause);
    return null;
  }
}

export function suggestConnection(provider: Runtime.SettingsProvider, catalog: ConnectionCatalog) {
  const displayName = provider.descriptor.label.trim();
  const slugBase =
    provider.identity.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'connection';
  const names = new Set(catalog.rows.map((row) => row.name.trim()));
  const slugs = new Set(catalog.rows.map((row) => row.slug));
  let name = displayName;
  let slug = slugBase;
  for (let suffix = 2; names.has(name); suffix++) name = `${displayName} ${suffix}`;
  for (let suffix = 2; slugs.has(slug); suffix++) slug = `${slugBase}-${suffix}`;
  return { name, slug };
}

export function modelConnectionLabels(catalog: ConnectionCatalog | null | undefined) {
  const providers = new Map<string, SettingsConnectionSummary[]>();
  for (const row of catalog?.rows ?? []) {
    const { packageId, entryId, scope, name } = row.provider;
    const key = JSON.stringify([packageId, entryId, scope, name]);
    const group = providers.get(key);
    if (group) group.push(row);
    else providers.set(key, [row]);
  }
  const labels = new Map<string, string>();
  for (const group of providers.values()) {
    if (group.length > 1) {
      for (const row of group) labels.set(row.basis.connectionId, row.name);
    }
  }
  return labels;
}

export function modelLabel(
  label: string,
  connectionId: string,
  labels: ReadonlyMap<string, string>,
) {
  const name = labels.get(connectionId);
  return name ? `${label} · ${name}` : label;
}

export function labelModelChoices(
  choices: Runtime.AgentModelChoice[],
  labels: ReadonlyMap<string, string>,
) {
  return choices.map((choice) =>
    choice.selection.kind === 'model'
      ? { ...choice, label: modelLabel(choice.label, choice.selection.connectionId, labels) }
      : choice,
  );
}

export async function providerCatalog(rpc: SettingsRpc) {
  const rows: SettingsProvidersPage['providers'] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: SettingsProvidersPage = await rpc.query('settings', 'providers', { offset });
    rows.push(...page.providers);
    offset = page.next;
  }
  return rows;
}

export async function readConnection(rpc: SettingsRpc, connectionId: string) {
  const detail = await rpc.query('settings', 'connection', {
    connectionId,
    includeEditingFacts: true,
  });
  if (detail.kind !== 'ready' || !detail.editing) throw new Error(tr('Connection is unavailable'));
  return { ...detail, editing: detail.editing };
}

export async function readCredential(
  rpc: SettingsRpc,
  connectionId: string,
  kind: ConnectionCredentialKind,
) {
  const result = await rpc.query('settings', 'credentialStatus', {
    locator: { scope: 'connection', connectionId, kind },
  });
  if (result.kind !== 'status')
    throw new Error(tr('Could not read or update settings.'), { cause: result.kind });
  return result.status;
}

export async function saveCredential(
  rpc: SettingsRpc,
  expected: ConnectionCredentialTarget,
  status: CredentialStatus,
  secret: string,
  usage: boolean,
) {
  const result = await rpc.mutate(
    'settings',
    usage ? 'saveUsageCredential' : 'saveCredential',
    {
      expected,
      expectedCredential: credentialBasis(status),
    },
    { secret },
  );
  if (result.kind !== (usage ? 'committed' : 'saved'))
    throw new Error(tr('Could not read or update settings.'), { cause: result.kind });
}

export async function deleteCredential(
  rpc: SettingsRpc,
  expectedConnection: ConnectionCredentialTarget,
  status: CredentialStatus,
) {
  const expected = credentialBasis(status);
  if (!expected) return;
  const result = await rpc.mutate('settings', 'deleteCredential', { expected, expectedConnection });
  if (result.kind !== 'committed')
    throw new Error(tr('Could not read or update settings.'), { cause: result.kind });
}

export async function modelChoices(rpc: SettingsRpc) {
  const page = await rpc.query('settings', 'models', { kind: 'start' });
  if (page.kind !== 'ready') throw new Error(tr('Refresh and try again.'), { cause: page.kind });
  const rows = [...page.choices];
  let cursor = page.next;
  while (cursor !== null) {
    const next = await rpc.query('settings', 'models', {
      kind: 'continue',
      revision: page.revision,
      cursor,
    });
    if (next.kind !== 'ready') throw new Error(tr('Refresh and try again.'), { cause: next.kind });
    rows.push(...next.choices);
    cursor = next.next;
  }
  return rows;
}

export async function setExternalRuntime(rpc: SettingsRpc, runtime: string, enabled: boolean) {
  const before = (await rpc.query('deploymentManager', 'read', {})).source.reference;
  const details = await rpc.query('agent', 'externalAgents', { inspect: true });
  const after = (await rpc.query('deploymentManager', 'read', {})).source.reference;
  const { target } = details;
  if (
    before.revision !== after.revision ||
    before.deployment !== after.deployment ||
    before.stateDomain !== after.stateDomain ||
    target.source.deployment !== after.deployment ||
    target.source.stateDomain !== after.stateDomain
  )
    throw new Error(tr('Refresh and try again.'));
  if (!details.runtimes.some(({ id }) => id === runtime)) throw new Error(tr('Unavailable'));
  const path = target.path as [string, ...string[]];
  const change: Runtime.SettingChange = {
    path: [...path, 'runtimes', runtime],
    value: { kind: 'boolean', value: enabled },
  };
  const result = await rpc.mutate('deploymentManager', 'configureBatch', {
    expectedRevision: after.revision,
    edits: [
      {
        instance: target.source.namespace,
        changes: details.configured ? [change] : [{ path }, change],
      },
    ],
  });
  if (result.status !== 'committed')
    throw new Error(tr('Could not read or update settings.'), { cause: result.status });
}

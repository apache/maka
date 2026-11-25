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

import type {
  DeploymentRef,
  ManagedInstance,
  PackageRef,
  SettingField,
  InstanceSettingsPage,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import type { SettingsRpc } from './rpc';

export async function readPlugins(rpc: SettingsRpc) {
  const first = await rpc.query('deploymentManager', 'instances', { kind: 'start' });
  const rows: ManagedInstance[] = [...first.instances];
  let after = first.next;
  while (after != null) {
    const page = await rpc.query('deploymentManager', 'instances', {
      kind: 'continue',
      source: first.source,
      after,
    });
    if (page.source.revision !== first.source.revision) throw new Error('Plugin inventory changed');
    rows.push(...page.instances);
    after = page.next;
  }
  return { source: first.source, rows };
}

export async function readPlugin(rpc: SettingsRpc, instance: string[]) {
  const [inventory, deployment] = await Promise.all([
    readPlugins(rpc),
    rpc.query('deploymentManager', 'read', {}),
  ]);
  const row = inventory.rows.find(
    (item) => JSON.stringify(item.instance) === JSON.stringify(instance),
  );
  if (!row || deployment.source.reference.revision !== inventory.source.revision)
    throw new Error('Plugin inventory changed');
  const fields: Pick<SettingField, 'key' | 'label' | 'description' | 'present'>[] = [];
  let after: string | null | undefined = null;
  do {
    const page: InstanceSettingsPage = await rpc.query('deploymentManager', 'readSettings', {
      source: inventory.source,
      instance,
      path: [],
      after,
    });
    for (const { key, label, description, present } of page.fields)
      fields.push({ key, label, description, present });
    after = page.next;
  } while (after != null);
  const bindings = Object.keys(deployment.source.input.instances[row.path[0]]?.bindings ?? {});
  return { row, source: inventory.source, fields, bindings: row.path.length === 1 ? bindings : [] };
}

export function committed<T>(
  result:
    | { status: 'committed'; value: T }
    | { status: 'conflict' }
    | { status: 'rejected'; reason: string },
) {
  if (result.status !== 'committed')
    throw new Error(result.status === 'rejected' ? result.reason : result.status);
  return result.value;
}

export async function downloadPlugin(rpc: SettingsRpc, source: DeploymentRef, url: string) {
  return committed(
    await rpc.mutate('deploymentManager', 'installUrl', { expectedRevision: source.revision, url }),
  );
}

export async function activatePlugin(
  rpc: SettingsRpc,
  source: DeploymentRef,
  name: string,
  bundle: PackageRef,
  usePackage: 'host' | 'ui' | 'composition',
) {
  committed(
    await rpc.mutate('deploymentManager', 'editComposition', {
      expectedRevision: source.revision,
      edits: [{ kind: 'insert', name, package: bundle, usePackage, settings: [], bindings: {} }],
    }),
  );
}

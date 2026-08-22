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

import { authorizeConnectionModel, effectiveBaseUrl } from '@maka/core/llm-connections';
import { readRuntimeHostConnectionCatalog } from './catalog-reader.js';
import type { RuntimeHostConnection } from './connection.js';
import { abortable } from './wait-for-ready.js';

type TargetConnection = Pick<RuntimeHostConnection, 'request'>;

export interface HostedExecutionTargetInput {
  readonly connectionSlug: string;
  readonly model: string;
  readonly baseUrl: string;
}

export async function configureHostedExecutionTarget(
  connection: TargetConnection,
  input: HostedExecutionTargetInput,
  signal?: AbortSignal,
): Promise<boolean> {
  const before = await abortable(() => readRuntimeHostConnectionCatalog(connection), signal);
  const target = before.connections.find((candidate) => candidate.slug === input.connectionSlug);
  if (!target) throw new Error('Runtime Host connection is unavailable');

  const baseUrl = new URL(input.baseUrl).toString();
  const enabledModelIds = [...new Set([...target.enabledModelIds, input.model])];
  const endpointChanged = canonicalBaseUrl(effectiveBaseUrl(target)) !== baseUrl;
  let changed = false;
  if (endpointChanged || !target.enabled || !target.enabledModelIds.includes(input.model)) {
    const updated = await abortable(
      () =>
        connection.request('connection.catalog.update', {
          expected: { connectionId: target.connectionId, revision: target.revision },
          changes: {
            name: target.name,
            baseUrl,
            enabled: true,
            enabledModelIds,
          },
        }),
      signal,
    );
    if (updated.kind !== 'committed') {
      throw new Error(`Runtime Host connection update was not committed: ${updated.kind}`);
    }
    changed = true;
  }

  // Best-effort: a fetch here is how the target picks up wire metadata for a
  // model the catalog has not described yet, so it is worth trying. It is not
  // worth failing over. A provider with no model-list endpoint refuses the
  // operation outright, one whose list lags simply returns the same array, and
  // in both cases the user's selection still authorizes the model — the
  // admission check below is what decides.
  if (endpointChanged || !target.models.some((model) => model.id === input.model)) {
    const fetched = await abortable(
      () =>
        connection.request('connection.models.fetch', {
          connectionId: target.connectionId,
        }),
      signal,
    );
    if (fetched.kind === 'committed') changed = true;
  }

  const after = await abortable(() => readRuntimeHostConnectionCatalog(connection), signal);
  const configured = after.connections.find(
    (candidate) => candidate.connectionId === target.connectionId,
  );
  if (
    !configured?.enabled ||
    canonicalBaseUrl(effectiveBaseUrl(configured)) !== baseUrl ||
    !authorizeConnectionModel(configured, input.model)
  ) {
    throw new Error('Runtime Host did not admit the requested model target');
  }
  return changed;
}

function canonicalBaseUrl(value: string): string | undefined {
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

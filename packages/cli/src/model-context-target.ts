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

import { modelProfilesWithContextTarget } from '@maka/core/model-thinking';
import {
  readRuntimeHostConnectionCatalog,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import type { ModelContextTargetUpdate } from './pi-tui-contracts.js';

/** Decimal K/M, matching the model catalog and Desktop selector. */
export function parseContextTarget(value: string): number | undefined {
  if (value.toLowerCase() === 'auto') return undefined;
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(value);
  const scale =
    match?.[2]?.toLowerCase() === 'm' ? 1_000_000 : match?.[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  const target = match ? Number(match[1]) * scale : NaN;
  if (!Number.isSafeInteger(target) || target <= 0) {
    throw new Error('Usage: /context [256k|512k|1m|auto]');
  }
  return target;
}

/** Writes through the connected Host, including its optimistic revision check. */
export async function updateRuntimeHostModelContextTarget(
  connection: RuntimeHostConnection,
  input: ModelContextTargetUpdate,
): Promise<void> {
  const catalog = await readRuntimeHostConnectionCatalog(connection);
  const selected = catalog.connections.find(
    (entry) => entry.connectionId === input.connectionId && entry.slug === input.connectionSlug,
  );
  const model = selected?.catalogEntries.find(
    (entry) => entry.id === input.model && entry.canUseAsChatDefault,
  );
  if (!selected || !model) throw new Error('The selected connection or model is unavailable.');
  if (input.target !== undefined) {
    if (!Number.isSafeInteger(input.target) || input.target <= 0) {
      throw new Error('Context target must be a positive integer.');
    }
    if (model.contextWindow === undefined) throw new Error('The model context maximum is unknown.');
    if (input.target > model.contextWindow) {
      throw new Error(`Context target exceeds the model maximum (${model.contextWindow} tokens).`);
    }
  }
  const result = await connection.request('connection.catalog.update', {
    expected: { connectionId: selected.connectionId, revision: selected.revision },
    changes: {
      name: selected.name,
      enabled: selected.enabled,
      enabledModelIds: selected.enabledModelIds,
      ...(selected.baseUrl === undefined ? {} : { baseUrl: selected.baseUrl }),
      relayModelProfiles: modelProfilesWithContextTarget(
        selected.relayModelProfiles,
        input.model,
        input.target,
      ),
    },
  });
  if (result.kind !== 'committed') {
    throw new Error(
      `Context target was not saved: ${result.kind}. Retry after refreshing the model catalog.`,
    );
  }
}

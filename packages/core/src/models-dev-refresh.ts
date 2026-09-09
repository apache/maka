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

import type { ProviderType } from './llm-connections.js';
import type { ModelMetadata } from './model-metadata.js';
import { readBoundedResponseText } from './bounded-response.js';
import {
  MODELS_DEV_SOURCE_URL,
  collectProjectionRemovals,
  projectModelsDevMetadata,
  selectModelsDevCatalog,
} from './models-dev-projection.js';

/** models.dev is a few megabytes of JSON; well past that it is not the catalog. */
export const MODELS_DEV_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

export type ModelsDevMetadataProjection = Partial<
  Record<ProviderType, Record<string, ModelMetadata>>
>;

export interface FetchModelsDevProjectionInput {
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  /**
   * The projection this caller is replacing. Given one, every path upstream
   * dropped is reported through `onRemovals` before the new projection is
   * returned.
   */
  readonly previous?: ModelsDevMetadataProjection;
  readonly onRemovals?: (paths: readonly string[]) => void;
}

/**
 * One models.dev refresh: fetch it under a byte bound, project it, and account
 * for what upstream stopped carrying.
 *
 * The build-time generator and the Runtime Host both run this. They differ
 * only in what they do with the result — the generator commits it to a
 * snapshot and refuses removals until a human acknowledges them, the Host
 * installs it for the process and records them — never in what the refresh
 * itself owes. A second implementation of any of these three steps is how the
 * two ended up disagreeing about which responses are too large and which
 * removals matter.
 *
 * Validation fails loud and whole: a caller that cannot accept a rejected
 * catalog keeps whatever it had.
 */
export async function fetchModelsDevProjection(
  input: FetchModelsDevProjectionInput,
): Promise<ModelsDevMetadataProjection> {
  const response = await input.fetch(MODELS_DEV_SOURCE_URL, {
    ...(input.signal ? { signal: input.signal } : {}),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
  const body = await readBoundedResponseText(
    response,
    MODELS_DEV_RESPONSE_MAX_BYTES,
    () => new Error('models.dev response exceeded the accepted size'),
  );
  const metadata = projectModelsDevMetadata(selectModelsDevCatalog(JSON.parse(body)));
  if (input.previous && input.onRemovals) {
    // Compared under the `metadata` key the generator uses, so both callers
    // report a removal by the same path.
    const removals = collectProjectionRemovals({ metadata: input.previous }, { metadata });
    if (removals.length > 0) input.onRemovals(removals);
  }
  return metadata;
}

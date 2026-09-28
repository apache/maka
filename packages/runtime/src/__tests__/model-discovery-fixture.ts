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

import assert from 'node:assert/strict';
import type { LlmConnection, ModelInfo } from '@maka/core/llm-connections';
import { runConnectionModelDiscoveryEffect } from '../model-fetcher.js';

export async function discoverModels(
  connection: LlmConnection,
  apiKey: string,
): Promise<ModelInfo[]> {
  const outcome = await runConnectionModelDiscoveryEffect(connection, apiKey, {
    fetch: globalThis.fetch,
  });
  if (!outcome.ok) assert.fail(outcome.error.kind);
  return [...outcome.models];
}

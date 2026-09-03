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

import { stableHash, toolCatalogHash } from './request-shape.js';
import type { MakaTool } from './tool-runtime.js';

const TOOL_ACTIVATION_IDENTITY = Symbol('maka.toolActivationIdentity');

type ToolWithActivationIdentity = MakaTool & {
  readonly [TOOL_ACTIVATION_IDENTITY]?: `sha256:${string}`;
};

export interface PluginToolActivationIdentity {
  readonly kind: 'plugin';
  readonly scopeId: string;
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly toolName: string;
}

/** Bind a Runtime-owned contribution identity to a Tool without exposing it to providers. */
export function bindToolActivationIdentity(
  tool: MakaTool,
  identity: PluginToolActivationIdentity,
): MakaTool {
  return Object.freeze({
    ...tool,
    [TOOL_ACTIVATION_IDENTITY]: stableHash({
      identity,
      schemaHash: toolCatalogHash([tool]),
    }),
  });
}

/**
 * Stable logical identity used by deferred-tool activation.
 *
 * Host wrappers without explicit contribution metadata fall back to their
 * canonical provider-visible shape, so rebuilding an equivalent wrapper does
 * not revoke activation. Dynamic contributors bind generation-aware metadata.
 */
export function toolActivationKey(tool: MakaTool): `sha256:${string}` {
  const explicit = (tool as ToolWithActivationIdentity)[TOOL_ACTIVATION_IDENTITY];
  return explicit ?? stableHash({ kind: 'host', schemaHash: toolCatalogHash([tool]) });
}

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

import type { ArchivedToolResultReason } from './tool-result-archive.js';
import {
  readToolResultArchiveResource,
  type ToolResultArchiveResourceReader,
} from './tool-result-archive-resource.js';
import type { MakaTool } from './tool-runtime.js';
import type { ModelProjectionTransition } from '@maka/core/model-projection-transition';
import { READ_DESCRIPTION, readParameters, resolveReadInput } from './read-page.js';

export interface ToolResultArchiveRecorderInput {
  sessionId: string;
  runtimeEventId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  /** The raw execution fact, for writers that name the artifact after it. */
  result?: unknown;
  serializedResult: string;
  bodySha256: string;
  originalBytes: number;
  originalEstimatedTokens: number;
  rewriteVersion: number;
  reason: ArchivedToolResultReason;
  sourceProjectionDigest?: `sha256:${string}`;
  previousTransitionId?: string;
}
export type ToolResultArchiveLocation =
  | { artifactId: string; ledger?: never }
  | {
      ledger: true;
      artifactId?: never;
      commitTransition?: (
        transition: ModelProjectionTransition,
        persist: (transition: ModelProjectionTransition) => Promise<void>,
      ) => Promise<boolean>;
    };
export type ToolResultArchiveRecorder = (
  input: ToolResultArchiveRecorderInput,
) => Promise<ToolResultArchiveLocation | void> | ToolResultArchiveLocation | void;

export interface ToolResultArchiveServices {
  archiveToolResult: ToolResultArchiveRecorder;
  readArchivedToolResultResource: ToolResultArchiveResourceReader['readArchivedToolResultResource'];
}

export interface ToolResultArchiveCapability {
  readonly services: ToolResultArchiveServices;
}

export function createToolResultArchiveCapability(
  services: ToolResultArchiveServices,
): ToolResultArchiveCapability {
  return Object.freeze({ services: Object.freeze({ ...services }) });
}

export function bindToolResultArchiveDecoder(
  tools: readonly MakaTool[],
  capability: ToolResultArchiveCapability | undefined,
): MakaTool[] {
  if (!capability) return [...tools];
  const existing = tools.find((tool) => tool.name === 'Read');
  const read: MakaTool = {
    ...existing,
    name: 'Read',
    activityKind: 'read',
    description: existing
      ? existing.description + ' Also accepts Maka tool-result paths returned in this session.'
      : 'Read a Maka tool-result address returned in this session. offset and limit are optional zero-based line pagination. Use the returned next object to continue. File access is not available.',
    parameters: readParameters,
    impl: async (input, ctx) => {
      const { path } = resolveReadInput(input);
      const prefix = 'maka://runtime/tool-results/';
      if (!path.startsWith(prefix)) {
        if (existing) return existing.impl(input, ctx);
        throw new Error(
          'This Read tool only reads Maka tool-result addresses returned in this session. File access is not available.',
        );
      }
      return readToolResultArchiveResource(
        capability.services,
        ctx.sessionId,
        input,
        ctx.abortSignal,
      );
    },
  };
  return [...tools.filter((tool) => tool.name !== 'Read'), read];
}

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

import { createExternalExecutionBoundary } from '@maka/core/sandbox-boundary';

import { AiSdkBackend, type AiSdkBackendInput } from '../ai-sdk-backend.js';
import {
  createToolResultArchiveCapability,
  type ToolResultArchiveCapability,
  type ToolResultArchiveServices,
} from '../tool-result-archive-capability.js';
import { ToolRuntime, type ToolRuntimeInput } from '../tool-runtime.js';
import type { ModelProjectionTransition } from '@maka/core/model-projection-transition';

export const readExternalExecutionBoundary: AiSdkBackendInput['readExecutionBoundary'] = async () =>
  createExternalExecutionBoundary();

type TestAiSdkBackendInput = Omit<AiSdkBackendInput, 'readExecutionBoundary'> &
  Partial<Pick<AiSdkBackendInput, 'readExecutionBoundary'>> & {
    testProjectionArtifacts?: boolean;
  };

export function createTestAiSdkBackend(input: TestAiSdkBackendInput): AiSdkBackend {
  const { testProjectionArtifacts, ...backendInput } = input;
  const artifacts = new Map<string, Uint8Array>();
  let nextArtifactId = 0;
  // A whole transition ledger by default, for the same reason the archive
  // capability above is whole: a lossy model-history rewrite is only allowed
  // when it can be made durable, so a fixture without this seam would silently
  // disable pruning rather than exercise it (#4283).
  const transitions: ModelProjectionTransition[] = [];
  return new AiSdkBackend({
    readExecutionBoundary: readExternalExecutionBoundary,
    loadModelProjectionTransitions: async () => ({
      transitions: [...transitions],
      unreadableTargets: new Set<string>(),
      unscopedUnreadable: 0,
    }),
    recordModelProjectionTransition: async (transition) => {
      transitions.push(transition);
    },
    providerStateIdentity: `sha256:${'1'.repeat(64)}`,
    ...backendInput,
    ...(testProjectionArtifacts
      ? {
          prepareDurableProjectionArtifact: ({ bytes }: { bytes: Uint8Array }) => {
            const relativePath = `artifact-${++nextArtifactId}`;
            const accepted = bytes.slice();
            return {
              ref: {
                kind: 'session_file' as const,
                sessionId: input.sessionId,
                relativePath,
              },
              persist: async () => {
                artifacts.set(relativePath, accepted);
              },
            };
          },
          readAttachmentBytes:
            input.readAttachmentBytes ??
            (async (ref) => {
              const bytes =
                ref.kind === 'session_file' ? artifacts.get(ref.relativePath) : undefined;
              return bytes
                ? { ok: true as const, bytes: bytes.slice() }
                : { ok: false as const, reason: 'not_found' as const };
            }),
        }
      : {}),
  });
}

/**
 * An archive capability for tests whose subject is the writer or the replay
 * reader. The unexercised halves resolve to `not_found` rather than being
 * absent: a test may leave a road untravelled, but the capability itself is
 * still whole, which is the invariant these fixtures used to be able to break.
 */
export function testToolResultArchive(
  services: Partial<ToolResultArchiveServices>,
): ToolResultArchiveCapability {
  return createToolResultArchiveCapability({
    archiveToolResult: async () => undefined,
    readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
    readArchivedToolResultResource: async () => ({ ok: false, reason: 'not_found' }),
    ...services,
  });
}

type TestToolRuntimeInput = Omit<ToolRuntimeInput, 'readExecutionBoundary' | 'turnId'> &
  Partial<Pick<ToolRuntimeInput, 'readExecutionBoundary' | 'turnId'>>;

/** Defaults to the turn id nearly every ToolRuntime test already uses. */
export function createTestToolRuntime(input: TestToolRuntimeInput): ToolRuntime {
  return new ToolRuntime({
    readExecutionBoundary: readExternalExecutionBoundary,
    turnId: 'turn-1',
    ...input,
  });
}

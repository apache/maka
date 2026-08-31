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

export const readExternalExecutionBoundary: AiSdkBackendInput['readExecutionBoundary'] = async () =>
  createExternalExecutionBoundary();

type TestAiSdkBackendInput = Omit<
  AiSdkBackendInput,
  'readExecutionBoundary' | 'workspaceIdentity'
> &
  Partial<Pick<AiSdkBackendInput, 'readExecutionBoundary' | 'workspaceIdentity'>>;

export function createTestAiSdkBackend(input: TestAiSdkBackendInput): AiSdkBackend {
  return new AiSdkBackend({
    readExecutionBoundary: readExternalExecutionBoundary,
    workspaceIdentity: 'workspace:v1:123e4567-e89b-42d3-a456-426614174000',
    ...input,
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

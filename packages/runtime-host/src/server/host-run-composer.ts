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

import type { RunCompositionSourceRevision } from '@maka/core/run-composition';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { RuntimePolicySnapshot } from '@maka/core/runtime-policy';
import type { AiSdkBackendInput } from '@maka/runtime/ai-sdk-backend';

import type { BackendFactoryContext } from '@maka/runtime/session-manager';

import type { MakaTool } from '@maka/runtime/tool-runtime';

import type { ToolAvailabilityConfig } from '@maka/runtime/tool-availability';

export interface HostModelPromptContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly emitSkillCatalogTrace?: (message: string, data?: Record<string, unknown>) => void;
}

export interface ResolvedRunPrompt {
  readonly text: string | undefined;
  readonly sourceRevisions: readonly RunCompositionSourceRevision[];
}

export interface HostRunComposer {
  readonly composerId: string;
  readonly composerRevision: string;
  readonly tools: readonly MakaTool[];
  readonly toolAvailability: ToolAvailabilityConfig;
  readonly resolveSystemPrompt: (context: HostModelPromptContext) => Promise<ResolvedRunPrompt>;
  readonly turnTailPrompt: (context: HostModelPromptContext) => Promise<string>;
  readonly planTraceContext?: AiSdkBackendInput['planTraceContext'];
  readonly release?: () => void;
}

export interface HostRunComposerFactoryContext {
  readonly backendContext: BackendFactoryContext;
  readonly connection: RuntimeExecutionConnection;
  readonly modelId: string;
  readonly runtimePolicy: RuntimePolicySnapshot;
  readonly contextWindow: number | null;
}

export type HostRunComposerFactory = (
  context: HostRunComposerFactoryContext,
) => HostRunComposer | Promise<HostRunComposer>;

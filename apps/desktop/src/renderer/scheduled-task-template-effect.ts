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

import type { ScheduledTaskEffect } from '@maka/core/scheduled-task';

type AgentRunEffect = Extract<ScheduledTaskEffect, { kind: 'agent_run' }>;
type AgentRunExecution = AgentRunEffect['execution'];

interface ScheduledTaskAgentRunTemplateInput {
  readonly usesDefaultHost: boolean;
  readonly projectPath?: string;
  readonly projectId?: string | null;
  readonly model?: Pick<
    AgentRunExecution,
    'llmConnectionId' | 'llmConnectionSlug' | 'model'
  >;
  readonly thinkingLevel?: AgentRunExecution['thinkingLevel'];
  readonly permissionMode: AgentRunExecution['permissionMode'];
  readonly collaborationMode: AgentRunExecution['collaborationMode'];
  readonly orchestrationMode: AgentRunExecution['orchestrationMode'];
}

/**
 * Scheduled Tasks are stored by the default Runtime Host. Never freeze a
 * different Host's workspace or connection into that Host-owned task.
 */
export function resolveScheduledTaskAgentRunTemplate(
  input: ScheduledTaskAgentRunTemplateInput,
): AgentRunEffect | undefined {
  if (
    !input.usesDefaultHost ||
    !input.projectPath ||
    input.projectId === undefined ||
    !input.model
  ) {
    return undefined;
  }
  return {
    kind: 'agent_run',
    execution: {
      cwd: input.projectPath,
      projectId: input.projectId,
      llmConnectionId: input.model.llmConnectionId,
      llmConnectionSlug: input.model.llmConnectionSlug,
      model: input.model.model,
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      permissionMode: input.permissionMode,
      collaborationMode: input.collaborationMode,
      orchestrationMode: input.orchestrationMode,
    },
  };
}

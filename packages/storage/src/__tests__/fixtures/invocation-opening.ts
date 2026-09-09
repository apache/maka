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

import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import type { RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import { buildInvocationOpenedEvent } from '@maka/core/runtime-invocation';
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import { createWorkspaceRuntimeStore } from '../../runtime-event-persistence.js';

export interface InvocationIdentity {
  sessionId: string;
  invocationId?: string;
  runId: string;
  turnId: string;
  openedAt?: number;
}

export function invocationOpening(
  overrides: Partial<RuntimeEventInvocationOpenedContent> = {},
): RuntimeEventInvocationOpenedContent {
  return {
    kind: 'invocation_opened',
    protocol: 'invocation_opened_v1',
    route: {
      provenance: 'runtime',
      backendKind: 'fake',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'fake',
      modelId: 'fake-model',
    },
    configuration: {
      cwd: '/tmp/cwd',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      orchestrationSource: 'session',
      toolMode: DEFAULT_TOOL_MODE,
      agentSwarmAuthorization: 'none',
    },
    root: { kind: 'user' },
    source: { kind: 'fresh' },
    ...overrides,
  };
}

/**
 * Commit the one fact that makes an invocation exist, the way the Runtime Host
 * does, so the AgentRunEvent ledger has an anchor to hang its events on.
 */
export async function openInvocation(
  workspaceRoot: string,
  identity: InvocationIdentity,
  content: RuntimeEventInvocationOpenedContent = invocationOpening(),
): Promise<void> {
  const invocationId = identity.invocationId ?? identity.runId;
  const { event } = encodeCanonicalRuntimeEvent(
    buildInvocationOpenedEvent({
      id: `invocation_opened:${invocationId}`,
      run: {
        sessionId: identity.sessionId,
        invocationId,
        runId: identity.runId,
        turnId: identity.turnId,
      },
      openedAt: identity.openedAt ?? 1,
      opening: content,
    }),
  );
  const store = createWorkspaceRuntimeStore(workspaceRoot);
  try {
    await store.appendRuntimeEvent(identity.sessionId, identity.runId, event);
  } finally {
    store.close();
  }
}

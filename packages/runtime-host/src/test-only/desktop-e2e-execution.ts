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

import type {
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
} from '@maka/core/backend-types';
import { buildHistoryCompactCheckpoint } from '@maka/runtime/history-compact-checkpoint';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { type BackendFactoryContext } from '@maka/runtime/session-manager';
import type { ExecutionRuntimeHostCandidateDependencies } from '../server/execution-candidate.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';

/** Fresh Desktop E2E workspaces never reconnect; keep election retry, skip production grace. */
export const DESKTOP_E2E_IDLE_GRACE_MS = 500;

/** The desktop E2E backend mirrors the one control capability exercised by the slash menu. */
export class DesktopE2eBackend extends FakeBackend {
  constructor(private readonly backendContext: BackendFactoryContext) {
    super(backendContext);
  }

  async compactHistory(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult> {
    const recordCheckpoint = this.backendContext.recordHistoryCompactCheckpoint;
    if (!recordCheckpoint) {
      throw new Error('Desktop E2E compaction requires a checkpoint recorder');
    }
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: this.sessionId,
      coveredRuntimeEvents: input.runtimeContext,
      // Shaped like a real sectioned checkpoint so the builder's summary
      // validation (#3029) admits this deterministic fixture.
      summary: [
        '## Goal',
        'Deterministic Desktop E2E context checkpoint.',
        '',
        '## Progress',
        '- deterministic compaction exercised',
        '',
        '## Next Steps',
        '1. continue',
        '',
        '## Critical Context',
        '- (none)',
      ].join('\n'),
    });
    await recordCheckpoint(checkpoint, input.turnId);
    return {};
  }
}

const DESKTOP_E2E_OAUTH_AUTHORIZATION = {
  startCodexAuthorization: async () => ({
    deviceAuthId: 'desktop-e2e-device-authorization',
    userCode: 'MAKA-E2E',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: Date.now() + 60_000,
    intervalMs: 1,
  }),
  pollCodexAuthorization: async () => ({
    authorizationCode: 'desktop-e2e-authorization-code',
    codeVerifier: 'desktop-e2e-code-verifier',
  }),
  exchangeCodexCode: async () => ({
    access_token: 'desktop-e2e-access-token',
    refresh_token: 'desktop-e2e-refresh-token',
    expires_at: Date.now() + 3_600_000,
  }),
};

export function createDesktopE2eExecutionCandidateDependencies(): ExecutionRuntimeHostCandidateDependencies {
  return {
    createComposition: (context, compositionOptions) =>
      createExecutionRuntimeHostComposition(
        context,
        {
          ...compositionOptions,
          bootstrapRuntimePolicy: false,
        },
        {
          primaryBackendFactory: (backendContext) => new DesktopE2eBackend(backendContext),
          oauthAuthorization: DESKTOP_E2E_OAUTH_AUTHORIZATION,
        },
      ),
  };
}

export function watchDesktopE2eParentProcess(close: () => Promise<void>): () => void {
  const desktopParentPid = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid === desktopParentPid && isProcessAlive(desktopParentPid)) return;
    clearInterval(parentWatch);
    void close().catch(() => {
      process.exitCode = 1;
    });
  }, 100);
  parentWatch.unref();
  return () => clearInterval(parentWatch);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

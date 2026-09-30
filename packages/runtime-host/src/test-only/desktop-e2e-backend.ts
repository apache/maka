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
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import type { BackendFactoryContext } from '@maka/runtime/session-manager';
import { createDesktopE2eCheckpoint } from './desktop-e2e-checkpoint.js';

export class DesktopE2eBackend extends FakeBackend {
  constructor(private readonly context: BackendFactoryContext) {
    super(context);
  }

  async compactHistory(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult> {
    const recordCheckpoint = this.context.recordHistoryCompactCheckpoint;
    if (!recordCheckpoint) {
      throw new Error('Desktop E2E compaction requires a checkpoint recorder');
    }

    const checkpoint = createDesktopE2eCheckpoint(this.sessionId, input.runtimeContext);
    await recordCheckpoint(checkpoint, input.turnId);
    return { outcome: { kind: 'compacted', checkpointId: checkpoint.checkpointId } };
  }
}

export const DESKTOP_E2E_OAUTH_AUTHORIZATION = {
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

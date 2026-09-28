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

import type { ExecutionRuntimeHostCandidateDependencies } from '../server/execution-candidate.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { DesktopE2eBackend, DESKTOP_E2E_OAUTH_AUTHORIZATION } from './desktop-e2e-backend.js';

/** Fresh Desktop E2E workspaces never reconnect; keep election retry, skip production grace. */
export const DESKTOP_E2E_IDLE_GRACE_MS = 500;

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
          // The fake primary reply must not race a real auxiliary title request.
          // Keep Host-owned naming/persistence, using its deterministic fallback.
          generateSessionTitle: async () => undefined,
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

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

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

export const SESSION_WORKSPACE_UNAVAILABLE_CODE = 'SESSION_WORKSPACE_UNAVAILABLE';

export function isSessionWorkspaceUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const event = error as { code?: unknown; message?: unknown };
  return event.code === SESSION_WORKSPACE_UNAVAILABLE_CODE
    || (typeof event.message === 'string' && event.message.includes(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}:`));
}

export async function assertSessionWorkspaceAvailable(
  cwd: string,
): Promise<void> {
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Error('Not a directory.');
    await access(cwd, constants.R_OK | constants.X_OK);
    return;
  } catch {
    // Fall through to the stable cross-process error contract.
  }

  const error = new Error(
    `${SESSION_WORKSPACE_UNAVAILABLE_CODE}: Working directory does not exist or is not accessible.`,
  );
  (error as Error & { code: string }).code = SESSION_WORKSPACE_UNAVAILABLE_CODE;
  throw error;
}

export async function resolveProjectContextRoot(
  sessionId: unknown,
  deps: {
    currentProjectRoot(): Promise<string>;
    readSessionCwd(sessionId: string): Promise<string>;
  },
): Promise<string> {
  if (sessionId === undefined) return deps.currentProjectRoot();
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Invalid project-context session id.');
  }

  const cwd = await deps.readSessionCwd(sessionId);
  await assertSessionWorkspaceAvailable(cwd);
  return cwd;
}

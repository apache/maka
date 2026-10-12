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

import type { ToastDiagnosticTarget } from '@maka/ui';

// Main raises this code (main/project-context-root.ts). An IPC rejection keeps
// only the message, so the code is matched as its prefix as well.
const SESSION_WORKSPACE_UNAVAILABLE_CODE = 'SESSION_WORKSPACE_UNAVAILABLE';

export function isSessionWorkspaceUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const event = error as { code?: unknown; message?: unknown };
  return event.code === SESSION_WORKSPACE_UNAVAILABLE_CODE
    || (typeof event.message === 'string' && event.message.includes(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}:`));
}

/**
 * The missing-working-directory toast. Contracts cannot import copy catalogs,
 * so the caller passes its locale's copy.
 */
export function showSessionWorkspaceUnavailableToast(
  toastApi: {
    error(title: string, description?: string, diagnosticDetails?: string, diagnosticTarget?: ToastDiagnosticTarget): void;
  },
  copy: { readonly workspaceUnavailableTitle: string; readonly workspaceUnavailableDescription: string },
  diagnosticTarget?: ToastDiagnosticTarget,
): void {
  toastApi.error(copy.workspaceUnavailableTitle, copy.workspaceUnavailableDescription, undefined, diagnosticTarget);
}

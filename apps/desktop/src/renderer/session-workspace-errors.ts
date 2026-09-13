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

import type { UiLocale } from '@maka/core/ui-locale';
import type { ToastDiagnosticTarget } from '@maka/ui';
import { getShellCopy } from './locales/shell-copy.js';

const SESSION_WORKSPACE_UNAVAILABLE_CODE = 'SESSION_WORKSPACE_UNAVAILABLE';

export function showSessionWorkspaceUnavailableToast(
  toastApi: {
    error(
      title: string,
      description?: string,
      diagnosticDetails?: string,
      diagnosticTarget?: ToastDiagnosticTarget,
    ): void;
  },
  locale: UiLocale,
  diagnosticTarget?: ToastDiagnosticTarget,
): void {
  const copy = getShellCopy(locale).errors;
  toastApi.error(
    copy.workspaceUnavailableTitle,
    copy.workspaceUnavailableDescription,
    undefined,
    diagnosticTarget,
  );
}

export function isSessionWorkspaceUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const event = error as { code?: unknown; message?: unknown };
  return (
    event.code === SESSION_WORKSPACE_UNAVAILABLE_CODE ||
    (typeof event.message === 'string' && event.message.includes(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}:`))
  );
}

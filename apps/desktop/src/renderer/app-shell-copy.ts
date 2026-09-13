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

import type { ConnectionTestResult } from '@maka/core/llm-connections';
import type { TextFileImportPreflightFailureReason } from '@maka/core/text-file-import';
import type { UiLocale } from '@maka/core/ui-locale';
import { generalizedErrorMessageForLocale } from '@maka/core/redaction';
import { classifiedErrorFallback } from './application/contracts/operation-diagnostics.js';
import { getShellCopy } from './locales/shell-copy.js';

export function messageReadErrorMessage(error: unknown, locale: UiLocale): string {
  const copy = getShellCopy(locale);
  return classifiedErrorFallback(error, copy.errors.messageRead, locale, 'message-read');
}

export function messageRefreshErrorMessage(error: unknown, locale: UiLocale): string {
  const copy = getShellCopy(locale);
  return classifiedErrorFallback(error, copy.errors.messageRefresh, locale, 'message-refresh');
}

export function commandPaletteActionErrorMessage(
  error: unknown,
  fallback: string,
  locale: UiLocale,
): string {
  return classifiedErrorFallback(error, fallback, locale, 'command-palette');
}

export function openPathActionErrorMessage(
  error: unknown,
  key: 'workspace' | 'project' | 'skills',
  locale: UiLocale,
): string {
  const copy = getShellCopy(locale);
  return classifiedErrorFallback(
    error,
    copy.errors.openPath(copy.paths[key]),
    locale,
    `open-path:${key}`,
  );
}

export function commandPaletteConnectionTestFailureMessage(result: ConnectionTestResult, locale: UiLocale): string {
  const fallback = commandPaletteConnectionTestFailureFallback(result, locale);
  return result.errorMessage
    ? generalizedErrorMessageForLocale(result.errorMessage, fallback, locale)
    : fallback;
}

function commandPaletteConnectionTestFailureFallback(result: ConnectionTestResult, locale: UiLocale): string {
  const copy = getShellCopy(locale).commandActions.connectionFailures;
  if (result.statusCode === 429) return copy.rateLimit;
  if (result.errorClass === 'timeout') return copy.timeout;
  if (result.errorClass === 'auth' || result.statusCode === 401 || result.statusCode === 403) {
    return copy.auth;
  }
  if (result.errorClass === 'network') return copy.network;
  if (result.errorClass === 'provider_unavailable' || (result.statusCode && result.statusCode >= 500)) {
    return copy.provider;
  }
  return copy.unknown;
}

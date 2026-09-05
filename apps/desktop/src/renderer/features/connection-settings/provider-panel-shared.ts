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

import { generalizedErrorMessageForLocale, redactSecrets } from '@maka/core/redaction';
import { type ConnectionTestResult } from '@maka/core/llm-connections';
import { type UiLocale } from '@maka/core/ui-locale';
import { getProviderSettingsCopy } from './settings-provider-copy.js';
import { cleanErrorMessage } from '../../application/contracts/connection-error-cleaner.js';

export type CredentialPresenceStatus = boolean | 'loading' | 'error';

export function providerPanelActionErrorMessage(error: unknown, locale: UiLocale = 'zh-CN'): string {
  const shared = getProviderSettingsCopy(locale).shared;
  // Electron wraps ipcMain.handle rejections as "Error invoking remote method
  // '<channel>': Error: <message>". Classify the original message, not the
  // wrapper — channel names like 'connections:fetchModels' contain "fetch",
  // which the keyword classifier reads as a network error.
  const cleaned = redactSecrets(cleanErrorMessage(error)).trim();
  const known = (shared.lastTest as Readonly<Record<string, string>>)[cleaned.toLowerCase()];
  if (known) return known;
  // Main-process handlers throw display-ready Chinese copy; keep it instead
  // of flattening it into a coarser classification or the generic fallback.
  if (locale === 'zh-CN' && /[\u3400-\u9fff]/.test(cleaned)) return cleaned;
  if (/connection_stale|Unable to delete Connection: connection_stale/i.test(cleaned)) {
    if (locale === 'zh-CN') return '连接状态已更新，请刷新列表后再删除。';
    if (locale === 'zh-TW') return '連線狀態已更新，請重新整理清單後再刪除。';
    return 'The connection changed while deleting. Refresh the list and try again.';
  }
  const classified = generalizedErrorMessageForLocale(new Error(cleaned), '', locale);
  return classified || shared.actionFallback;
}

export interface ConnectionTestTroubleshootingCopy {
  /** Auth-class failure copy (errorClass 'auth' or HTTP 401/403). */
  auth: string;
  /** Final fallback copy when no failure class matched. */
  recheck: string;
}

// Shared connection-test failure classification. The Models connection
// sheet and the Account page used to each hand-copy this table; only the
// surface-specific troubleshooting copy differs, so callers inject it.
export function connectionTestFailureFallback(
  result: ConnectionTestResult,
  copy: ConnectionTestTroubleshootingCopy,
  locale: UiLocale = 'zh-CN',
): string {
  const shared = getProviderSettingsCopy(locale).shared;
  if (result.statusCode === 429) return shared.rateLimit;
  if (result.errorClass === 'timeout') return shared.timeout;
  if (result.errorClass === 'auth' || result.statusCode === 401 || result.statusCode === 403) {
    return copy.auth;
  }
  if (result.errorClass === 'provider_unavailable' || (result.statusCode !== undefined && result.statusCode >= 500)) {
    return shared.unavailable;
  }
  if (result.errorClass === 'network') return shared.network;
  return copy.recheck;
}

export function connectionTestFailureMessage(
  result: ConnectionTestResult,
  copy: ConnectionTestTroubleshootingCopy,
  locale: UiLocale = 'zh-CN',
): string {
  const fallback = connectionTestFailureFallback(result, copy, locale);
  if (!result.errorMessage) return fallback;
  return generalizedErrorMessageForLocale(new Error(result.errorMessage), fallback, locale);
}

export function connectionLastTestMessageDisplay(message: string | undefined, locale: UiLocale = 'zh-CN'): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  const copy = getProviderSettingsCopy(locale).shared;
  const known = (copy.lastTest as Readonly<Record<string, string>>)[normalized];
  if (known) return known;
  const classified = generalizedErrorMessageForLocale(new Error(trimmed), '', locale);
  return classified || copy.statusUnavailable;
}

import { generalizedErrorMessage, generalizedErrorMessageChinese, redactSecrets } from '@maka/core/redaction';
import {
  type ConnectionTestResult,
  type CreateConnectionInput,
  type LlmConnection,
  type ModelDiscoveryResult,
  type RequestHeaderUpdate,
  type SavedRequestHeaders,
  type ProviderCategory,
  type ProviderType,
  type UpdateConnectionInput,
} from '@maka/core/llm-connections';
import { type UiLocale } from '@maka/core/ui-locale';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy.js';
import { cleanErrorMessage } from '../model-connection-errors.js';

export interface ConnectionsBridge {
  list(): Promise<LlmConnection[]>;
  getDefault(): Promise<string | null>;
  setDefault(slug: string | null): Promise<void>;
  create(input: CreateConnectionInput): Promise<LlmConnection>;
  update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
  delete(slug: string): Promise<void>;
  test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult>;
  fetchModels(slug: string): Promise<ModelDiscoveryResult>;
  hasSecret(slug: string): Promise<boolean>;
  getRequestHeaders(slug: string): Promise<SavedRequestHeaders>;
  setRequestHeaders(
    slug: string,
    headers: readonly RequestHeaderUpdate[],
  ): Promise<SavedRequestHeaders>;
  subscribeEvents?(handler: () => void): () => void;
}

export type CredentialPresenceStatus = boolean | 'loading' | 'error';

export function providerPanelActionErrorMessage(error: unknown, locale: UiLocale = 'zh'): string {
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
  if (/[\u3400-\u9fff]/.test(cleaned)) return cleaned;
  if (/connection_stale|Unable to delete Connection: connection_stale/i.test(cleaned)) {
    return locale === 'zh'
      ? '连接状态已更新，请刷新列表后再删除。'
      : 'The connection changed while deleting. Refresh the list and try again.';
  }
  const classified = locale === 'zh'
    ? generalizedErrorMessageChinese(new Error(cleaned), '')
    : generalizedErrorMessage(new Error(cleaned), '');
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
  locale: UiLocale = 'zh',
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
  locale: UiLocale = 'zh',
): string {
  const fallback = connectionTestFailureFallback(result, copy, locale);
  if (!result.errorMessage) return fallback;
  return locale === 'zh'
    ? generalizedErrorMessageChinese(new Error(result.errorMessage), fallback)
    : generalizedErrorMessage(new Error(result.errorMessage), fallback);
}

export function connectionLastTestMessageDisplay(message: string | undefined, locale: UiLocale = 'zh'): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  const copy = getProviderSettingsCopy(locale).shared;
  const known = (copy.lastTest as Readonly<Record<string, string>>)[normalized];
  if (known) return known;
  const classified = locale === 'zh'
    ? generalizedErrorMessageChinese(new Error(trimmed), '')
    : generalizedErrorMessage(new Error(trimmed), '');
  return classified || copy.statusUnavailable;
}

export function categoryLabel(category: ProviderCategory, locale: UiLocale = 'zh'): string {
  return getProviderSettingsCopy(locale).shared.categories[category];
}

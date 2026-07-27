import {
  generalizedErrorMessage,
  generalizedErrorMessageChinese,
  type ConnectionTestResult,
  type CreateConnectionInput,
  type LlmConnection,
  type ModelDiscoveryResult,
  type ProviderCategory,
  type ProviderType,
  type UiLocale,
  type UpdateConnectionInput,
} from '@maka/core';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy.js';

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
  subscribeEvents?(handler: () => void): () => void;
}

export type CredentialPresenceStatus = boolean | 'loading' | 'error';

export function providerPanelActionErrorMessage(error: unknown, locale: UiLocale = 'zh'): string {
  const fallback = getProviderSettingsCopy(locale).shared.actionFallback;
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
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

export function nextSlug(type: ProviderType, existing: string[]): string {
  // Lowercase before sweeping: provider types are not all lowercase
  // ('MiniMax', 'MiniMax-cn'), and replacing uppercase letters with '-'
  // produced slugs like '-ini-ax' that validateSlug rejects.
  const base = type.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!existing.includes(base)) return base;
  // Unbounded increment: `existing` is finite, so some suffix is always free.
  // (The previous bounded loop fell back to `${base}-${Date.now()}` after -99
  // without checking `existing`, which could return an already-taken slug the
  // save path then rejects.)
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

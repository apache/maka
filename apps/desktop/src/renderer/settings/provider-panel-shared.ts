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
import type {
  CredentialProfileReadinessView,
  CredentialProfileUsageView,
} from '../../preload/bridge-contract.js';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy.js';
import { cleanErrorMessage } from '../model-connection-errors.js';

export type {
  CredentialProfileReadinessView,
  CredentialProfileUsageView,
} from '../../preload/bridge-contract.js';

export interface ProfileCreateInput {
  readonly label: string;
  readonly weight: number;
}

export interface ProfileUpdateInput {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly label?: string;
  readonly weight?: number;
}

export interface ProfileBasisInput {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly enabled?: boolean;
}

export interface ProfileRoutingModeInput {
  readonly mode: 'legacy_primary' | 'balanced';
  readonly strategy?: 'smooth_weighted_round_robin' | 'priority_failover';
  readonly orderedProfileIds?: readonly string[];
}

export interface ProfileCredentialInput {
  readonly profileId: string;
  readonly secret: string;
}

export interface ProfileTestInput {
  readonly profileId: string;
  readonly modelId?: string;
}

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
  profiles?: {
    query(slug: string): Promise<CredentialProfileReadinessView>;
    usage(slug: string, profileId: string): Promise<CredentialProfileUsageView>;
    create(slug: string, input: ProfileCreateInput): Promise<void>;
    update(slug: string, input: ProfileUpdateInput): Promise<void>;
    setEnabled(slug: string, input: ProfileBasisInput & { enabled: boolean }): Promise<void>;
    remove(slug: string, input: ProfileBasisInput): Promise<void>;
    setRoutingMode(slug: string, input: ProfileRoutingModeInput): Promise<void>;
    setCredential(slug: string, input: ProfileCredentialInput): Promise<void>;
    test(slug: string, input: ProfileTestInput): Promise<ConnectionTestResult>;
    fetchModels(slug: string, input: ProfileBasisInput): Promise<ModelDiscoveryResult>;
  };
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
  const balancedActivationMessages: Readonly<Record<string, readonly [string, string]>> = {
    'balanced routing requires at least two configured profiles': [
      '至少需要两个已配置的账号才能启用路由。',
      'At least two configured accounts are required to enable routing.',
    ],
    'balanced routing requires at least two enabled profiles': [
      '至少需要启用两个账号才能启用路由。',
      'At least two enabled accounts are required to enable routing.',
    ],
    'balanced routing requires every enabled profile to have a configured credential': [
      '每个已启用账号都需要先完成登录或配置凭据。',
      'Every enabled account must be signed in or have credentials configured.',
    ],
    'balanced routing requires the primary profile credential to be configured': [
      '主账号需要先完成登录或配置凭据。',
      'The primary account must be signed in or have credentials configured.',
    ],
    'balanced routing requires at least one enabled model with two or more verified profiles': [
      '至少需要两个账号通过同一模型的连接测试，才能启用路由。',
      'At least two accounts must pass a connection test for the same model.',
    ],
  };
  const activationMessage = balancedActivationMessages[cleaned.toLowerCase()];
  if (activationMessage) return activationMessage[locale === 'zh' ? 0 : 1];
  if (/balanced routing requires enabled model .+ to have a verified profile/i.test(cleaned)) {
    return locale === 'zh'
      ? '每个已启用模型都需要至少一个通过连接测试的账号。'
      : 'Every enabled model needs at least one account that passed its connection test.';
  }
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

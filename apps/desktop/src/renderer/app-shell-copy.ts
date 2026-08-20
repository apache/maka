import type { ConnectionTestResult } from '@maka/core/llm-connections';
import type { TextFileImportPreflightFailureReason } from '@maka/core/text-file-import';
import type { UiLocale } from '@maka/core/ui-locale';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core/redaction';
import { getShellCopy } from './locales/shell-copy.js';
import { describeProviderAccountFailure } from './session-error-presentation.js';

const SESSION_READ_MESSAGES_ERROR_MARKER = 'MAKA_SESSION_READ_MESSAGES_ERROR:';

export function messageReadErrorMessage(error: unknown, locale: UiLocale): string {
  return sessionMessageErrorMessage(error, getShellCopy(locale).errors.messageRead, locale);
}

export function messageRefreshErrorMessage(error: unknown, locale: UiLocale): string {
  return sessionMessageErrorMessage(error, getShellCopy(locale).errors.messageRefresh, locale);
}

function sessionMessageErrorMessage(error: unknown, fallback: string, locale: UiLocale): string {
  const raw = error instanceof Error ? error.message : String(error);
  const markerIndex = raw.indexOf(SESSION_READ_MESSAGES_ERROR_MARKER);
  if (markerIndex < 0 || locale === 'en') return localizedErrorMessage(error, fallback, locale);
  const marked = raw.slice(markerIndex + SESSION_READ_MESSAGES_ERROR_MARKER.length).trim();
  return marked.split(/\r?\n/, 1)[0]?.trim() || fallback;
}

function localizedErrorMessage(error: unknown, fallback: string, locale: UiLocale): string {
  return locale === 'zh' ? generalizedErrorMessageChinese(error, fallback) : generalizedErrorMessage(error, fallback);
}

export function commandPaletteActionErrorMessage(error: unknown, fallback: string, locale: UiLocale): string {
  return localizedErrorMessage(error, fallback, locale);
}

export function openPathActionErrorMessage(
  error: unknown,
  key: 'workspace' | 'project' | 'skills',
  locale: UiLocale,
): string {
  const copy = getShellCopy(locale);
  return localizedErrorMessage(error, copy.errors.openPath(copy.paths[key]), locale);
}

export function commandPaletteConnectionTestFailureMessage(result: ConnectionTestResult, locale: UiLocale): string {
  const fallback = commandPaletteConnectionTestFailureFallback(result, locale);
  const failure = result.providerFailure;
  return failure?.boundedProviderMessage === true && failure.message
    ? failure.message
    : fallback;
}

function commandPaletteConnectionTestFailureFallback(result: ConnectionTestResult, locale: UiLocale): string {
  const accountFailure = describeProviderAccountFailure(result.providerFailure?.errorClass, locale);
  if (accountFailure) return accountFailure;
  const copy = getShellCopy(locale).commandActions.connectionFailures;
  switch (result.providerFailure?.errorClass) {
    case 'Auth':
      return copy.auth;
    case 'Timeout':
      return copy.timeout;
    case 'RateLimit':
      return copy.rateLimit;
    case 'Network':
      return copy.network;
    case 'ProviderUnavailable':
      return copy.provider;
    default:
      break;
  }
  if (result.errorClass === 'timeout') return copy.timeout;
  if (result.errorClass === 'auth') return copy.auth;
  if (result.errorClass === 'network') return copy.network;
  if (result.errorClass === 'provider_unavailable') return copy.provider;
  return copy.unknown;
}

export function openSkillFailureCopy(
  reason: 'invalid_id' | 'missing' | 'blocked_path' | 'not_file' | 'not_directory' | 'open_failed',
  locale: UiLocale,
): string {
  return getShellCopy(locale).skillActions.openFailures[reason];
}

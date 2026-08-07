import type { ChatConfigurationReason, SessionEvent, UiLocale } from '@maka/core';
import {
  parseNoRealConnectionError,
} from '@maka/core';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import { describeSessionErrorReason } from './session-error-presentation.js';

const NO_REAL_CONNECTION_CODE = 'NO_REAL_CONNECTION';
const NO_REAL_CONNECTION_REASON_RE = /NO_REAL_CONNECTION:([a-z_]+): /;

export function isNoRealConnectionError(error: unknown): boolean {
  return parseNoRealConnectionError(error).matched;
}

export function isNoRealConnectionEvent(event: Extract<SessionEvent, { type: 'error' }>): boolean {
  return event.code === NO_REAL_CONNECTION_CODE || parseNoRealConnectionError(event.message).matched;
}

export function noRealConnectionReasonFromError(error: unknown): string | undefined {
  return parseNoRealConnectionError(error).reason;
}

export function noRealConnectionReasonFromEvent(event: Extract<SessionEvent, { type: 'error' }>): string | undefined {
  return parseNoRealConnectionError(
    event.reason ? `${NO_REAL_CONNECTION_CODE}:${event.reason}` : event.message,
  ).reason;
}

export function noRealConnectionSetupDescription(reason: string | undefined, locale: UiLocale = 'zh'): string {
  const copy = getDesktopConversationCopy(locale).model;
  return reason && Object.hasOwn(copy.configurationReason, reason)
    ? copy.configurationReason[reason as ChatConfigurationReason]
    : copy.configurationFallback;
}

export function sessionEventErrorMessage(
  event: Extract<SessionEvent, { type: 'error' }>,
  locale: UiLocale = 'zh',
): string {
  if (isNoRealConnectionEvent(event)) {
    return noRealConnectionSetupDescription(noRealConnectionReasonFromEvent(event), locale);
  }
  const reasonDescription = describeSessionErrorReason(event.reason, locale);
  if (reasonDescription) return reasonDescription;
  const fallback = getDesktopConversationCopy(locale).actions.conversationErrorFallback;
  return localizedShellErrorMessage(new Error(event.message), fallback, locale);
}

/**
 * @knipignore Retained as the canonical raw-error cleaner. It has no live
 * call sites by design: the fail-soft contract tests (session-open-routing,
 * permission-response-ipc-boundary, renderer-startup-fail-soft, skills, etc.)
 * assert.doesNotMatch that visible toasts pipe `cleanErrorMessage(error)`, so
 * this export is referenced by name across the suite even though nothing imports it.
 */
export function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return cleanEventMessage(raw);
}

export function cleanEventMessage(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(NO_REAL_CONNECTION_REASON_RE, '')
    .replace(`${NO_REAL_CONNECTION_CODE}: `, '');
}

export function modelSetupToastCopy(
  reason: string | undefined,
  fallback: string,
  locale: UiLocale = 'zh',
): { title: string; description: string } {
  const copy = getDesktopConversationCopy(locale).model;
  if (reason === 'connection_missing') {
    return {
      title: copy.connectionMissingTitle,
      description: noRealConnectionSetupDescription(reason, locale),
    };
  }
  return {
    title: copy.setupTitle,
    description: fallback,
  };
}

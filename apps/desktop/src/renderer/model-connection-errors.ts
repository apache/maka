import type { ChatConfigurationReason } from '@maka/core/connection-readiness';
import type { SessionEvent } from '@maka/core/events';
import type { UiLocale } from '@maka/core/ui-locale';
import { parseNoRealConnectionError } from '@maka/core/connection-error-copy';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
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

  // Provider errors reach this boundary with a stable code plus the
  // allowlisted, redacted, bounded summary produced by ModelAdapter. Keep that
  // structured result authoritative instead of reclassifying words or HTTP
  // status fragments in the presentation layer. The bounded marker is the only
  // proof that `message` is safe to render verbatim: a code alone can be a Node
  // transport code whose message is unbounded internal text.
  if (event.boundedProviderMessage === true && event.message.length > 0) {
    return event.message;
  }

  const fallback = getDesktopConversationCopy(locale).actions.conversationErrorFallback;
  return fallback;
}

/**
 * Canonical raw-error cleaner: strips the Electron IPC wrapper so error
 * classifiers see the main-process message, not the channel name (which can
 * contain classifier keywords, e.g. the "fetch" in 'connections:fetchModels').
 * Raw output must not reach a toast unclassified — see
 * providerPanelActionErrorMessage for the display-side contract.
 */
export function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return cleanEventMessage(raw);
}

export function cleanEventMessage(message: string): string {
  // Electron serializes a rejected handler as `${error.name}: ${error.message}`,
  // so custom classes arrive as e.g. "ConnectionModelDiscoveryPreconditionError: …".
  return message
    .replace(/^Error invoking remote method '[^']+': (?:[A-Za-z_$][\w$]*)?Error: /, '')
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

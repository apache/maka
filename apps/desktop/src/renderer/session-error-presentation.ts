import type { UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

/**
 * Locale-aware allowlist for stable ErrorEvent.reason values emitted by the
 * runtime. Unknown reasons intentionally return undefined so callers can use
 * their existing safe fallback instead of displaying raw provider text.
 */
export function describeSessionErrorReason(reason: string | undefined, locale: UiLocale = 'zh'): string | undefined {
  const copy = getDesktopConversationCopy(locale).turnError;
  switch (reason?.toLowerCase()) {
    case 'context_overflow':
      return copy.contextOverflow;
    case 'timeout':
      return copy.timeout;
    case 'auth':
      return copy.auth;
    case 'provider_billing':
      return copy.providerBilling;
    case 'provider_unavailable':
      return copy.provider;
    case 'rate_limit':
      return copy.rateLimit;
    case 'network':
      return copy.network;
    default:
      return undefined;
  }
}

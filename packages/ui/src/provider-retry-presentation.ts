import type { BannerStatus } from '@astryxdesign/core';
import type { ProviderRetryEvent } from '@maka/core/events';
import type { UiLocale } from '@maka/core/ui-locale';
import { getConversationCopy } from './conversation-copy.js';

export interface ProviderRetryPresentation {
  status: Extract<BannerStatus, 'warning'>;
  title: string;
  description: string;
}

export function presentProviderRetry(
  retry: ProviderRetryEvent,
  locale: UiLocale = 'zh',
): ProviderRetryPresentation {
  const copy = getConversationCopy(locale).messages;
  return {
    status: 'warning',
    title:
      retry.phase === 'scheduled'
        ? copy.providerRetryScheduled(
            Math.max(1, Math.ceil(retry.delayMs / 1_000)),
            retry.attempt,
            retry.maxAttempts,
          )
        : copy.providerRetryStarted(retry.attempt, retry.maxAttempts),
    description: copy.providerRetryReason[retry.reason],
  };
}

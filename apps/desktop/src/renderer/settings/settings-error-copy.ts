import { generalizedErrorMessageChinese } from '@maka/core/redaction';
import { type UiLocale } from '@maka/core/ui-locale';
import { redactSecrets } from '@maka/ui';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';

export function settingsActionErrorMessage(error: unknown, locale: UiLocale = 'zh'): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const classified = locale === 'zh' ? generalizedErrorMessageChinese(new Error(raw), '') : '';
  if (classified) return classified;
  const redacted = redactSecrets(raw).trim();
  if (locale === 'zh' && redacted && /[\u4E00-\u9FFF]/.test(redacted)) return redacted;
  return getSettingsSharedCopy(locale).unknownError;
}

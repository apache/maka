import type { UiLocale } from '@maka/core/ui-locale';

export function projectPickerTitle(locale: UiLocale): string {
  return locale === 'zh' ? '添加项目' : 'Add project';
}

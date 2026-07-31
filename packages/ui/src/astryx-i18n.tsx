import { useMemo, type ReactNode } from 'react';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { getConversationCopy } from './conversation-copy.js';
import { useUiLocale } from './locale-context.js';
import type { UiLocale } from './locale-helpers.js';

/**
 * Astryx ships no `zh` message catalog: its built-in strings ("Copy code",
 * "Task list", "(opens in new tab)", checkbox/table ARIA names) render in
 * English. On a Chinese-first product every Astryx component we adopt would
 * otherwise leak English into the accessibility tree.
 *
 * This provider sits at the renderer root so EVERY Astryx subtree inherits the
 * catalog — scoping it per feature does not scale: each new slice would have
 * to remember to re-wrap. Overrides are keyed off our own shared copy
 * catalogue, so translations keep one home.
 *
 * The map covers the components whose copy sources exist today. A slice that
 * adopts a new Astryx surface appends its `@astryx.*` keys here in the same
 * PR that adds the copy they resolve from (the Markdown catalog lands with
 * PR 7, for example) — an override for a component nothing renders is dead
 * config, not coverage.
 *
 * `en` needs no overrides — it resolves to Astryx's shipped defaults.
 */
export function AstryxLocaleProvider({ children }: { children: ReactNode }) {
  const locale = useUiLocale();
  // Referentially stable per locale: the provider memoises its context value
  // on the overrides object, so a fresh map every render would re-render
  // every Astryx i18n consumer on every AppShell render.
  const overrides = useMemo(() => astryxMessageOverrides(locale), [locale]);
  return (
    <InternationalizationProvider locale={locale} overrides={overrides}>
      {children}
    </InternationalizationProvider>
  );
}

export function astryxMessageOverrides(locale: UiLocale) {
  if (locale === 'en') return undefined;
  const shared = getSharedUiCopy(locale);
  const conversation = getConversationCopy(locale);
  const form = shared.formControls;
  return {
    [locale]: {
      '@astryx.codeBlock.copyCode': shared.markdown.copyCode,
      '@astryx.codeBlock.copied': shared.markdown.copiedCode,
      '@astryx.codeBlock.code': shared.markdown.code,
      '@astryx.markdown.taskList': shared.markdown.taskList,
      '@astryx.markdown.table': shared.markdown.table,
      '@astryx.checkboxList.item.checkbox': shared.markdown.checkbox,
      '@astryx.link.newTab': shared.markdown.opensInNewTab,
      '@astryx.dialog.close': shared.primitives.close,
      '@astryx.popover.close': shared.primitives.close,
      '@astryx.lightbox.close': shared.primitives.close,
      '@astryx.toast.dismiss': shared.toast.closeNotification,
      '@astryx.toast.viewport': shared.toast.notifications,
      '@astryx.selector.placeholder': form.selectPlaceholder,
      '@astryx.selector.searchPlaceholder': form.searchPlaceholder,
      '@astryx.selector.searchOptions': form.searchOptions,
      '@astryx.selector.clearLabel': form.clear,
      '@astryx.multiSelector.selectPlaceholder': form.selectPlaceholder,
      '@astryx.multiSelector.selectAll': form.selectAll,
      '@astryx.multiSelector.searchPlaceholder': form.searchPlaceholder,
      '@astryx.multiSelector.searchOptions': form.searchOptions,
      '@astryx.multiSelector.clearAll': form.clearAll,
      '@astryx.numberInput.clearLabel': form.clear,
      '@astryx.dateInput.placeholder': form.datePlaceholder,
      '@astryx.dateInput.dialogLabel': form.dateDialog,
      '@astryx.dateInput.closeCalendar': form.closeCalendar,
      '@astryx.dateInput.openCalendar': form.openCalendar,
      '@astryx.dateInput.toggleCalendarClose': form.closeCalendar,
      '@astryx.dateInput.clear': form.clear,
      '@astryx.dateTimeInput.placeholder': form.dateTimePlaceholder,
      '@astryx.dateTimeInput.dialogLabel': form.dateTimeDialog,
      '@astryx.dateTimeInput.timePlaceholder': form.dateTimeTimePlaceholder,
      '@astryx.dateTimeInput.timeSuffix': form.dateTimeSuffix,
      '@astryx.timeInput.placeholder': form.timePlaceholder,
      '@astryx.timeInput.clearLabel': form.clear,
      '@astryx.chat.composer.placeholder': conversation.composer.placeholder,
      '@astryx.chat.composerInput.label': conversation.composer.textareaAriaLabel,
      '@astryx.chatLayoutScrollButton.scrollToBottom': conversation.chat.jumpLatest,
      '@astryx.chatSendButton.stop': conversation.composer.stopLabel,
      '@astryx.chatSendButton.send': conversation.composer.sendLabel,
    },
  };
}

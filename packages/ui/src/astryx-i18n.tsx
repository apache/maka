import { useMemo, type ReactNode } from 'react';
import { InternationalizationProvider } from '@astryxdesign/core/i18n';
import type { Overrides } from '@astryxdesign/core/i18n';
import { getSharedUiCopy } from './shared-ui-copy.js';
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
 *
 * `@astryx.field.required` / `@astryx.field.optional` are the one pair Astryx
 * does not ship: upstream hard-codes those two words in `FieldLabel`. The keys
 * exist because `patches/@astryxdesign+core+0.2.0.patch` routes the marker
 * through this catalog — see that patch's entry in `patches/README.md`.
 */
export function AstryxLocaleProvider({
  children,
  overrides: scopedOverrides,
}: {
  children: ReactNode;
  overrides?: Record<string, string>;
}) {
  const locale = useUiLocale();
  // Referentially stable per locale: the provider memoises its context value
  // on the overrides object, so a fresh map every render would re-render
  // every Astryx i18n consumer on every AppShell render.
  const overrides = useMemo(() => {
    const base = astryxMessageOverrides(locale)?.[locale];
    if (!scopedOverrides) return base ? { [locale]: base } : undefined;
    return { [locale]: { ...base, ...scopedOverrides } };
  }, [locale, scopedOverrides]);
  return (
    <InternationalizationProvider locale={locale} overrides={overrides}>
      {children}
    </InternationalizationProvider>
  );
}

export function astryxMessageOverrides(locale: UiLocale): Overrides | undefined {
  if (locale === 'en') return undefined;
  const shared = getSharedUiCopy(locale);
  const form = shared.formControls;
  const a = shared.astryx;
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
      '@astryx.resizable.handle.label': shared.primitives.resizeHandle,
      '@astryx.popover.close': shared.primitives.close,
      '@astryx.toast.dismiss': shared.toast.closeNotification,
      '@astryx.toast.viewport': shared.toast.notifications,
      '@astryx.field.required': form.required,
      '@astryx.field.optional': form.optional,
      '@astryx.selector.placeholder': form.selectPlaceholder,
      '@astryx.selector.clearLabel': form.clear,
      '@astryx.numberInput.clearLabel': form.clear,

      // Chat — the transcript, composer and scroll affordances Astryx owns
      // since #1795 moved the chat surfaces onto ChatLayout.
      '@astryx.chat.composer.placeholder': a.chat.composerPlaceholder,
      '@astryx.chat.composerDrawer.label': a.chat.composerDrawerLabel,
      '@astryx.chat.composerInput.label': a.chat.composerInputLabel,
      '@astryx.chat.messageAriaLabel': a.chat.messageAriaLabel,
      '@astryx.chat.pastedText.expand': a.chat.pastedTextExpand,
      '@astryx.chat.status.delivered': a.chat.statusDelivered,
      '@astryx.chat.status.failed': a.chat.statusFailed,
      '@astryx.chat.status.read': a.chat.statusRead,
      '@astryx.chat.status.sending': a.chat.statusSending,
      '@astryx.chat.status.sent': a.chat.statusSent,
      '@astryx.chatComposerDrawer.collapse': a.chat.drawerCollapse,
      '@astryx.chatComposerDrawer.expand': a.chat.drawerExpand,
      '@astryx.chatLayout.newMessages': a.chat.newMessages,
      '@astryx.chatLayoutScrollButton.scrollToBottom': a.chat.scrollToBottom,
      '@astryx.chatSendButton.send': a.chat.send,
      '@astryx.chatSendButton.stop': a.chat.stop,
      '@astryx.chatToolCalls.error': a.chat.toolCallsError,
      '@astryx.chatToolCalls.groupLabel': a.chat.toolCallsGroupLabel,
      '@astryx.chatTriggerMenu.suggestions': a.chat.triggerSuggestions,

      // Command palette — `list.label` stays a call-site override because each
      // palette names its own result list.
      '@astryx.commandPalette.emptyBootstrap': a.commandPalette.emptyBootstrap,
      '@astryx.commandPalette.emptySearch': a.commandPalette.emptySearch,
      '@astryx.commandPalette.input.placeholder': a.commandPalette.inputPlaceholder,
      '@astryx.commandPalette.label': a.commandPalette.label,
      '@astryx.commandPalette.loading': shared.primitives.loading,
      '@astryx.commandPalette.noResultsFor': a.commandPalette.noResultsFor,
      '@astryx.commandPalette.resultCount': a.commandPalette.resultCount,

      // DateTimeInput and the Calendar it opens.
      '@astryx.dateInput.clear': form.clear,
      '@astryx.dateInput.closeCalendar': a.dateTime.closeCalendar,
      '@astryx.dateInput.openCalendar': a.dateTime.openCalendar,
      '@astryx.dateInput.toggleCalendarClose': a.dateTime.closeCalendar,
      '@astryx.dateTimeInput.dialogLabel': a.dateTime.dialogLabel,
      '@astryx.dateTimeInput.placeholder': a.dateTime.datePlaceholder,
      '@astryx.dateTimeInput.timePlaceholder': a.dateTime.timePlaceholder,
      '@astryx.dateTimeInput.timeSuffix': a.dateTime.timeSuffix,
      '@astryx.calendar.dayInRange': a.calendar.dayInRange,
      '@astryx.calendar.dayRangeEnd': a.calendar.dayRangeEnd,
      '@astryx.calendar.dayRangeStart': a.calendar.dayRangeStart,
      '@astryx.calendar.dayRangeStartAndEnd': a.calendar.dayRangeStartAndEnd,
      '@astryx.calendar.daySelected': a.calendar.daySelected,
      '@astryx.calendar.nextMonth': a.calendar.nextMonth,
      '@astryx.calendar.previousMonth': a.calendar.previousMonth,
      '@astryx.calendar.rangeCompleteAnnounce': a.calendar.rangeCompleteAnnounce,
      '@astryx.calendar.rangeStartAnnounce': a.calendar.rangeStartAnnounce,

      // Menus, selectors and inputs.
      '@astryx.dropdownMenu.label': a.menus.dropdown,
      '@astryx.moreMenu.label': a.menus.more,
      '@astryx.selector.searchOptions': a.search.options,
      '@astryx.selector.searchPlaceholder': a.search.placeholder,
      '@astryx.multiSelector.searchOptions': a.search.options,
      '@astryx.multiSelector.searchPlaceholder': a.search.placeholder,
      '@astryx.multiSelector.selectPlaceholder': form.selectPlaceholder,
      '@astryx.multiSelector.clearAll': a.multiSelector.clearAll,
      '@astryx.multiSelector.selectAll': a.multiSelector.selectAll,
      '@astryx.textInput.clearLabel': form.clear,
      '@astryx.input.statusButton.error': a.inputStatus.error,
      '@astryx.input.statusButton.success': a.inputStatus.success,
      '@astryx.input.statusButton.warning': a.inputStatus.warning,

      // Shell chrome: side nav, tabs, banners, breadcrumbs, resize handles.
      '@astryx.appShell.mobileNavigation': a.appShell.mobileNavigation,
      '@astryx.banner.collapse': a.banner.collapse,
      '@astryx.banner.expand': a.banner.expand,
      '@astryx.banner.dismiss': shared.primitives.close,
      '@astryx.breadcrumbs.label': a.breadcrumbs.label,
      '@astryx.sideNav.label': a.sideNav.label,
      '@astryx.sideNav.resizeSidebar': a.sideNav.resizeSidebar,
      '@astryx.sideNavCollapseButton.collapseSidebar': a.sideNav.collapseSidebar,
      '@astryx.sideNavCollapseButton.expandSidebar': a.sideNav.expandSidebar,
      '@astryx.sideNavItem.collapse': a.sideNav.itemCollapse,
      '@astryx.sideNavItem.expand': a.sideNav.itemExpand,
      '@astryx.tabList.label': a.tabList.label,

      // Table (usage settings) and the chat transcript's attachment chrome.
      '@astryx.table.label': a.table.label,
      '@astryx.table.noData': a.table.noData,
      '@astryx.table.filter.allPlaceholder': a.table.filterAll,
      '@astryx.table.filter.apply': a.table.filterApply,
      '@astryx.table.filter.reset': a.table.filterReset,
      '@astryx.tableFiltering.filterByColumn': a.table.filterByColumn,
      '@astryx.thumbnail.fallbackName': a.thumbnail.fallbackName,
      '@astryx.thumbnail.open': a.thumbnail.open,
      '@astryx.thumbnail.remove': a.thumbnail.remove,
      '@astryx.token.remove': a.token.remove,
    },
  };
}

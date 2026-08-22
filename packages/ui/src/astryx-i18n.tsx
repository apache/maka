/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useContext, useMemo, type ReactNode } from 'react';
import {
  InternationalizationContext,
  InternationalizationProvider,
} from '@astryxdesign/core/i18n';
import type { Overrides } from '@astryxdesign/core/i18n';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { ASTRYX_COPY_ZH } from './astryx-copy.js';
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
  const ambient = useContext(InternationalizationContext);
  // Referentially stable per locale: the provider memoises its context value
  // on the overrides object, so a fresh map every render would re-render
  // every Astryx i18n consumer on every AppShell render.
  const overrides = useMemo(() => {
    const base = astryxMessageOverrides(locale)?.[locale];
    const inherited = ambient.locale === locale
      ? ambient.overrides?.[locale]
      : undefined;
    const merged = { ...base, ...inherited, ...scopedOverrides };
    if (Object.keys(merged).length === 0) return undefined;
    return {
      ...(ambient.locale === locale ? ambient.overrides : undefined),
      [locale]: merged,
    };
  }, [ambient.locale, ambient.overrides, locale, scopedOverrides]);
  const inheritAmbient = ambient.locale === locale;
  return (
    <InternationalizationProvider
      locale={locale}
      messages={inheritAmbient ? ambient.messages : undefined}
      dir={inheritAmbient ? ambient.direction : undefined}
      overrides={overrides}
    >
      {children}
    </InternationalizationProvider>
  );
}

export function astryxMessageOverrides(locale: UiLocale): Overrides | undefined {
  if (locale === 'en') {
    // en otherwise resolves to Astryx's shipped defaults. These two are the
    // sole exceptions: the drawer toggle's aria-label doubles as its visible
    // hover tooltip (composer.css renders attr(aria-label)), and the shipped
    // "Collapse {label}" / "Expand {label}" read as state names there — the
    // click affordance is the tooltip's whole point.
    return {
      en: {
        '@astryx.chatComposerDrawer.collapse': 'Click to collapse {label}',
        '@astryx.chatComposerDrawer.expand': 'Click to expand {label}',
      },
    };
  }
  const shared = getSharedUiCopy(locale);
  const form = shared.formControls;
  // `locale` is narrowed to 'zh' past the early return; the catalogue lives
  // off-barrel in astryx-copy.ts because nothing outside this map consumes it.
  const astryx = ASTRYX_COPY_ZH;
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

      // App shell — the skip link is always the first focusable control, so an
      // untranslated fallback pollutes every Chinese Computer Use observation.
      '@astryx.appShell.mobileNavigation': astryx.appShell.mobileNavigation,
      '@astryx.appShell.skipToContent': astryx.appShell.skipToContent,

      // Chat — the transcript, composer and scroll affordances Astryx owns
      // since #1795 moved the chat surfaces onto ChatLayout.
      '@astryx.chat.composer.placeholder': astryx.chat.composerPlaceholder,
      '@astryx.chat.composerDrawer.label': astryx.chat.composerDrawerLabel,
      '@astryx.chat.composerInput.label': astryx.chat.composerInputLabel,
      '@astryx.chat.messageAriaLabel': astryx.chat.messageAriaLabel,
      '@astryx.chat.pastedText.expand': astryx.chat.pastedTextExpand,
      '@astryx.chat.status.delivered': astryx.chat.statusDelivered,
      '@astryx.chat.status.failed': astryx.chat.statusFailed,
      '@astryx.chat.status.read': astryx.chat.statusRead,
      '@astryx.chat.status.sending': astryx.chat.statusSending,
      '@astryx.chat.status.sent': astryx.chat.statusSent,
      '@astryx.chatComposerDrawer.collapse': astryx.chat.drawerCollapse,
      '@astryx.chatComposerDrawer.expand': astryx.chat.drawerExpand,
      '@astryx.chatLayout.newMessages': astryx.chat.newMessages,
      '@astryx.chatLayoutScrollButton.scrollToBottom': astryx.chat.scrollToBottom,
      '@astryx.chatToolCalls.error': astryx.chat.toolCallsError,
      '@astryx.chatToolCalls.groupLabel': astryx.chat.toolCallsGroupLabel,
      '@astryx.chatTriggerMenu.suggestions': astryx.chat.triggerSuggestions,

      // Command palette — `list.label` stays a call-site override because each
      // palette names its own result list.
      '@astryx.commandPalette.emptyBootstrap': astryx.commandPalette.emptyBootstrap,
      '@astryx.commandPalette.emptySearch': astryx.commandPalette.emptySearch,
      '@astryx.commandPalette.input.placeholder': astryx.commandPalette.inputPlaceholder,
      '@astryx.commandPalette.label': astryx.commandPalette.label,
      '@astryx.commandPalette.loading': shared.primitives.loading,
      '@astryx.commandPalette.noResultsFor': astryx.commandPalette.noResultsFor,
      '@astryx.commandPalette.resultCount': astryx.commandPalette.resultCount,

      // DateTimeInput and the Calendar it opens.
      '@astryx.dateInput.clear': form.clear,
      '@astryx.dateInput.closeCalendar': astryx.dateTime.closeCalendar,
      '@astryx.dateInput.openCalendar': astryx.dateTime.openCalendar,
      '@astryx.dateInput.toggleCalendarClose': astryx.dateTime.closeCalendar,
      '@astryx.dateTimeInput.dialogLabel': astryx.dateTime.dialogLabel,
      '@astryx.dateTimeInput.placeholder': astryx.dateTime.datePlaceholder,
      '@astryx.dateTimeInput.timePlaceholder': astryx.dateTime.timePlaceholder,
      '@astryx.dateTimeInput.timeSuffix': astryx.dateTime.timeSuffix,
      '@astryx.calendar.dayInRange': astryx.calendar.dayInRange,
      '@astryx.calendar.dayRangeEnd': astryx.calendar.dayRangeEnd,
      '@astryx.calendar.dayRangeStart': astryx.calendar.dayRangeStart,
      '@astryx.calendar.dayRangeStartAndEnd': astryx.calendar.dayRangeStartAndEnd,
      '@astryx.calendar.daySelected': astryx.calendar.daySelected,
      '@astryx.calendar.nextMonth': astryx.calendar.nextMonth,
      '@astryx.calendar.previousMonth': astryx.calendar.previousMonth,
      '@astryx.calendar.rangeCompleteAnnounce': astryx.calendar.rangeCompleteAnnounce,
      '@astryx.calendar.rangeStartAnnounce': astryx.calendar.rangeStartAnnounce,

      // Menus, selectors and inputs.
      '@astryx.dropdownMenu.label': astryx.menus.dropdown,
      '@astryx.moreMenu.label': astryx.menus.more,
      '@astryx.selector.searchOptions': astryx.search.options,
      '@astryx.selector.searchPlaceholder': astryx.search.placeholder,
      '@astryx.multiSelector.searchOptions': astryx.search.options,
      '@astryx.multiSelector.searchPlaceholder': astryx.search.placeholder,
      '@astryx.multiSelector.selectPlaceholder': form.selectPlaceholder,
      '@astryx.multiSelector.clearAll': astryx.multiSelector.clearAll,
      '@astryx.multiSelector.selectAll': astryx.multiSelector.selectAll,
      '@astryx.textInput.clearLabel': form.clear,
      '@astryx.input.statusButton.error': astryx.inputStatus.error,
      '@astryx.input.statusButton.success': astryx.inputStatus.success,
      '@astryx.input.statusButton.warning': astryx.inputStatus.warning,

      // Lightbox — reached through useLightbox in chat-turn.tsx (image
      // preview), not a <Lightbox> element; JSX-tag scans miss it.
      '@astryx.lightbox.mediaViewer': astryx.lightbox.mediaViewer,
      '@astryx.lightbox.close': shared.primitives.close,
      '@astryx.lightbox.previous': astryx.lightbox.previous,
      '@astryx.lightbox.next': astryx.lightbox.next,

      // Shell chrome: side nav, tabs, banners, breadcrumbs, resize handles.
      '@astryx.banner.collapse': astryx.banner.collapse,
      '@astryx.banner.expand': astryx.banner.expand,
      '@astryx.banner.dismiss': shared.primitives.close,
      '@astryx.breadcrumbs.label': astryx.breadcrumbs.label,
      '@astryx.sideNav.label': astryx.sideNav.label,
      '@astryx.sideNav.resizeSidebar': astryx.sideNav.resizeSidebar,
      '@astryx.sideNavCollapseButton.collapseSidebar': astryx.sideNav.collapseSidebar,
      '@astryx.sideNavCollapseButton.expandSidebar': astryx.sideNav.expandSidebar,
      '@astryx.sideNavItem.collapse': astryx.sideNav.itemCollapse,
      '@astryx.sideNavItem.expand': astryx.sideNav.itemExpand,
      '@astryx.tabList.label': astryx.tabList.label,

      // Table (usage settings) and the chat transcript's attachment chrome.
      '@astryx.table.label': astryx.table.label,
      '@astryx.thumbnail.fallbackName': astryx.thumbnail.fallbackName,
      '@astryx.thumbnail.open': astryx.thumbnail.open,
      '@astryx.thumbnail.remove': astryx.thumbnail.remove,
      '@astryx.token.remove': astryx.token.remove,
    },
  };
}

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

/**
 * Chinese copy for Astryx's own message catalog, which ships no `zh`: without
 * an override every `@astryx.*` string falls back to the shipped `en` catalog
 * silently. Grouped by the component that renders it so a slice adopting a new
 * Astryx surface can see at a glance whether its strings are already covered.
 *
 * Deliberately NOT exported from the package barrel (`index.ts`): the only
 * consumer is `astryxMessageOverrides` in `astryx-i18n.tsx`, and per the
 * README's off-barrel convention a symbol earns barrel export only with a
 * cross-package consumer. Strings that Maka's own components also render live
 * in `shared-ui-copy.ts` instead and are referenced from the override map, so
 * shared wording keeps one home.
 *
 * `zh` only: `astryxMessageOverrides` returns `undefined` for `en`, which
 * resolves Astryx's shipped defaults — an `en` mirror here would be dead
 * config drifting against upstream.
 */
export interface AstryxCopy {
  appShell: { mobileNavigation: string; skipToContent: string };
  banner: { collapse: string; expand: string };
  breadcrumbs: { label: string };
  calendar: {
    dayInRange: string;
    dayRangeEnd: string;
    dayRangeStart: string;
    dayRangeStartAndEnd: string;
    daySelected: string;
    nextMonth: string;
    previousMonth: string;
    rangeCompleteAnnounce: string;
    rangeStartAnnounce: string;
  };
  chat: {
    composerPlaceholder: string;
    composerDrawerLabel: string;
    composerInputLabel: string;
    messageAriaLabel: string;
    pastedTextExpand: string;
    statusDelivered: string;
    statusFailed: string;
    statusRead: string;
    statusSending: string;
    statusSent: string;
    drawerCollapse: string;
    drawerExpand: string;
    newMessages: string;
    scrollToBottom: string;
    toolCallsError: string;
    toolCallsGroupLabel: string;
    triggerSuggestions: string;
  };
  commandPalette: {
    emptyBootstrap: string;
    emptySearch: string;
    inputPlaceholder: string;
    label: string;
    noResultsFor: string;
    resultCount: string;
  };
  dateTime: {
    closeCalendar: string;
    openCalendar: string;
    dialogLabel: string;
    datePlaceholder: string;
    timePlaceholder: string;
    timeSuffix: string;
  };
  inputStatus: { error: string; success: string; warning: string };
  lightbox: { mediaViewer: string; previous: string; next: string };
  menus: { dropdown: string; more: string };
  multiSelector: { clearAll: string; selectAll: string };
  /** Selector and MultiSelector render the same two search affordances. */
  search: { options: string; placeholder: string };
  sideNav: {
    label: string;
    resizeSidebar: string;
    collapseSidebar: string;
    expandSidebar: string;
    itemCollapse: string;
    itemExpand: string;
  };
  tabList: { label: string };
  table: { label: string };
  thumbnail: { fallbackName: string; open: string; remove: string };
  token: { remove: string };
}

export const ASTRYX_COPY_ZH: AstryxCopy = {
  appShell: { mobileNavigation: '移动端导航', skipToContent: '跳到主要内容' },
  banner: { collapse: '收起', expand: '展开' },
  breadcrumbs: { label: '面包屑导航' },
  calendar: {
    dayInRange: '{date}，在所选范围内',
    dayRangeEnd: '{date}，范围结束',
    dayRangeStart: '{date}，范围开始',
    dayRangeStartAndEnd: '{date}，范围开始与结束',
    daySelected: '{date}，已选择',
    nextMonth: '下个月',
    previousMonth: '上个月',
    rangeCompleteAnnounce: '已选择范围：{start} 至 {end}。',
    rangeStartAnnounce: '开始日期 {date}。请选择结束日期。',
  },
  chat: {
    composerPlaceholder: '输入消息…',
    composerDrawerLabel: '附加内容',
    composerInputLabel: '消息输入框',
    messageAriaLabel: '消息：{status}',
    pastedTextExpand: '展开',
    statusDelivered: '已送达',
    statusFailed: '发送失败',
    statusRead: '已读',
    statusSending: '发送中',
    statusSent: '已发送',
    // «点击» is deliberate: the string doubles as the toggle band's visible
    // hover tooltip (composer.css renders attr(aria-label)), where the click
    // affordance is the whole point.
    drawerCollapse: '点击收起{label}',
    drawerExpand: '点击展开{label}',
    newMessages: '跳到最新消息',
    scrollToBottom: '滚动到底部',
    toolCallsError: '错误：{message}',
    toolCallsGroupLabel: '{count} 次工具调用',
    triggerSuggestions: '建议',
  },
  commandPalette: {
    emptyBootstrap: '输入以搜索',
    emptySearch: '无结果',
    inputPlaceholder: '搜索…',
    label: '命令面板',
    noResultsFor: '没有与「{query}」匹配的结果',
    resultCount: '{count, number} 条结果',
  },
  dateTime: {
    closeCalendar: '关闭日历',
    openCalendar: '打开日历',
    dialogLabel: '选择日期',
    datePlaceholder: '选择日期',
    timePlaceholder: '选择时间',
    timeSuffix: '{label}时间',
  },
  inputStatus: { error: '错误详情', success: '成功详情', warning: '警告详情' },
  lightbox: { mediaViewer: '媒体查看器', previous: '上一张', next: '下一张' },
  menus: { dropdown: '菜单', more: '更多选项' },
  multiSelector: { clearAll: '清除全部{label}', selectAll: '全选' },
  search: { options: '搜索选项', placeholder: '搜索…' },
  sideNav: {
    label: '侧边导航',
    resizeSidebar: '调整侧边栏宽度',
    collapseSidebar: '收起侧边栏',
    expandSidebar: '展开侧边栏',
    itemCollapse: '收起{label}',
    itemExpand: '展开{label}',
  },
  tabList: { label: '标签页' },
  table: { label: '表格' },
  thumbnail: { fallbackName: '缩略图', open: '打开{accessibleName}', remove: '移除{accessibleName}' },
  token: { remove: '移除{label}' },
};

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

import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from '@maka/ui/icons';
import {
  IconButton,
  useUiLocale,
} from '@maka/ui';
import { Icon } from '@astryxdesign/core/Icon';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { getShellCopy } from './locales/shell-copy';

/**
 * Match SideNavItem collapsed/expanded icon slot: Astryx `renderIconSlot`
 * uses size `sm` (1rem) + color `secondary`. Titlebar follows that recipe
 * — not raw Lucide size props — so chrome and sidebar share one glyph look.
 */
function ChromeIcon(props: { icon: typeof Search }) {
  return <Icon icon={props.icon} size="sm" color="secondary" />;
}

/**
 * A titlebar column toggle: one button whose icon, tooltip, accessible name and
 * `aria-expanded` all read from the same boolean, in both directions.
 *
 * The sidebar's toggle used to be Astryx's `SideNavCollapseButton`, wired
 * across the tree by a `handleRef` so a click reached SideNav's internal
 * collapse state, which called `onCollapsedChange`, which set the shell state
 * that was already being passed back down as `isCollapsed`. Three hops to a
 * setter the shell holds directly — and none of the component's own outputs
 * survived: the shell overrode its label and its icon, its `isCollapsible`
 * check could not fail (the ref reads `null` on first render and falls back to
 * `true`), and its mobile branch is unreachable behind `breakpoint: 'none'`.
 * What is left after removing all of that is this button, which is also exactly
 * what the workbar's toggle already was.
 */
function ChromeColumnToggle(props: {
  collapsed: boolean;
  expandLabel: string;
  collapseLabel: string;
  expandIcon: typeof Search;
  collapseIcon: typeof Search;
  className?: string;
  onToggle(): void;
}) {
  const label = props.collapsed ? props.expandLabel : props.collapseLabel;
  return (
    <Tooltip content={label}>
      <IconButton
        label={label}
        icon={<ChromeIcon icon={props.collapsed ? props.expandIcon : props.collapseIcon} />}
        variant="ghost"
        size="md"
        className={
          props.className
            ? `maka-titlebar-action ${props.className}`
            : 'maka-titlebar-action'
        }
        onClick={props.onToggle}
        aria-expanded={!props.collapsed}
      />
    </Tooltip>
  );
}

export function AppShellTopbarActions(props: {
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  onOpenSearchModal(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  return (
    <div className="maka-shell-topbar-rail" data-maka-contract="shell-topbar-rail" role="group" aria-label={copy.windowActions}>
      <Tooltip content={copy.searchConversations}>
        <IconButton
          label={copy.searchConversations}
          icon={<ChromeIcon icon={Search} />}
          variant="ghost"
          size="md"
          className="maka-titlebar-action"
          data-maka-search-trigger="true"
          onClick={props.onOpenSearchModal}
        />
      </Tooltip>
      <ChromeColumnToggle
        collapsed={props.sidebarCollapsed}
        expandLabel={copy.expandSidebar}
        collapseLabel={copy.collapseSidebar}
        expandIcon={PanelLeftOpen}
        collapseIcon={PanelLeftClose}
        onToggle={props.onToggleSidebar}
      />
      {/* Collapsed "new task" lives on the SideNav rail (SessionSidebarNav),
          not here — a third titlebar button duplicated the rail icon and made
          left-cluster width state-dependent for drag-region math. */}
    </div>
  );
}

export function WorkbarToggle(props: {
  collapsed: boolean;
  className?: string;
  onToggle(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  return (
    <ChromeColumnToggle
      collapsed={props.collapsed}
      expandLabel={copy.expandWorkbar}
      collapseLabel={copy.collapseWorkbar}
      expandIcon={PanelRightOpen}
      collapseIcon={PanelRightClose}
      className={props.className}
      onToggle={props.onToggle}
    />
  );
}

/**
 * The titlebar's right edge.
 *
 * It used to also carry a `…` menu holding 问题反馈 / 打开命令面板 / 打开帮助 /
 * 打开健康中心 — a drawer of four things that each belong somewhere else.
 * 健康中心 was a duplicate of the Settings nav entry, 问题反馈 only opened
 * Settings → 关于, and the other two now have real homes: the keyboard sheet is
 * a row on 关于, and the palette keeps ⌘K, which that sheet documents.
 *
 * What is left is the collapsed workbar's restore affordance. While the
 * workbar is open, the matching toggle belongs to the workbar's tab toolbar:
 * tabs, new-tab and panel visibility are one local control group. That toolbar
 * occupies this same titlebar band, so the control keeps its screen position
 * across the hand-off instead of moving down into a second row.
 *
 * The titlebar is also the only row in the app that already knows where the
 * platform's native window controls are: `.maka-window-titlebar` reserves
 * `env(titlebar-area-*)` on both sides, so this button clears the macOS traffic
 * lights and the Windows caption strip without either platform being named
 * here. A toggle parked anywhere else would have to restate that.
 */
export function AppShellWorkspaceTopActions(props: {
  workbarAvailable: boolean;
  workbarCollapsed: boolean;
  onToggleWorkbar(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  // Nothing to toggle outside a session or while the panel-local control is
  // mounted; an empty no-drag rectangle would only subtract from the window's
  // drag surface.
  if (!props.workbarAvailable || !props.workbarCollapsed) return null;

  return (
    <div className="maka-workspace-top-actions" role="toolbar" aria-label={copy.workspaceActions}>
      <WorkbarToggle collapsed onToggle={props.onToggleWorkbar} />
    </div>
  );
}

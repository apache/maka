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

import type { ComponentProps, ReactNode } from 'react';
import {
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from '@maka/ui/icons';
import {
  IconButton,
} from '@maka/ui';
import { Icon } from '@astryxdesign/core/Icon';
import { Tooltip } from '@astryxdesign/core/Tooltip';

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

function AppShellTopbarActions(props: {
  copy: { windowActions: string; searchConversations: string; expandSidebar: string; collapseSidebar: string };
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  onOpenSearchModal(): void;
}) {
  const copy = props.copy;
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

/** Keep the native drag surface mounted while Settings owns its controls. */
export function WindowTitlebar(props: ComponentProps<typeof AppShellTopbarActions> & {
  obscured: boolean;
  modalOpen: boolean;
  settingsOpen: boolean;
  children: ReactNode;
}) {
  return (
    <header className="maka-window-titlebar" aria-hidden={props.obscured || undefined} inert={props.modalOpen || undefined}>
      {!props.settingsOpen && <><AppShellTopbarActions {...props} />{props.children}</>}
    </header>
  );
}

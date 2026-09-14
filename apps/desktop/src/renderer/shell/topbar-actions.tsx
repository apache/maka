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
  Search,
  SquarePen,
} from '@maka/ui/icons';
import { IconButton } from '@maka/ui';
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
 */
function ChromeColumnToggle(props: {
  collapsed: boolean;
  expandLabel: string;
  collapseLabel: string;
  expandIcon: typeof Search;
  collapseIcon: typeof Search;
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
        className="maka-titlebar-action"
        onClick={props.onToggle}
        aria-expanded={!props.collapsed}
      />
    </Tooltip>
  );
}

export function AppShellTopbarActions(props: {
  copy: {
    windowActions: string;
    expandSidebar: string;
    collapseSidebar: string;
    searchConversations: string;
    newTask: string;
  };
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  onOpenSearchModal(): void;
  onNewTask(): void;
}) {
  const { copy } = props;
  return (
    <div className="maka-shell-topbar-rail" data-maka-contract="shell-topbar-rail" role="group" aria-label={copy.windowActions}>
      <ChromeColumnToggle
        collapsed={props.sidebarCollapsed}
        expandLabel={copy.expandSidebar}
        collapseLabel={copy.collapseSidebar}
        expandIcon={PanelLeftOpen}
        collapseIcon={PanelLeftClose}
        onToggle={props.onToggleSidebar}
      />
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
      <Tooltip content={copy.newTask}>
        <IconButton
          label={copy.newTask}
          icon={<ChromeIcon icon={SquarePen} />}
          variant="ghost"
          size="md"
          className="maka-titlebar-action"
          onClick={props.onNewTask}
        />
      </Tooltip>
    </div>
  );
}

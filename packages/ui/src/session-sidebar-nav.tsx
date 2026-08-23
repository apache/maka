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

import type { ScheduledTask } from '@maka/core/scheduled-task';
import { AlertCircle, Blocks, Download, Settings, SquarePen, Timer } from './icons.js';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import { useUiLocale } from './locale-context.js';
import { getShellControlsCopy } from './shell-controls-copy.js';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { Tooltip } from '@astryxdesign/core/Tooltip';

export function SessionSidebarNav(props: {
  selection: NavSelection;
  scheduledTasks?: ScheduledTask[];
  moduleMemory?: NavModuleMemory;
  onSelect(selection: NavSelection): void;
  onNew(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).navigation;
  const extensionsActive = props.selection.section === 'extensions';
  const automationsActive = props.selection.section === 'automations';
  const moduleMemory = props.moduleMemory ?? { extensions: 'skills', automations: 'scheduled-tasks' };
  const activeScheduledTaskCount = (props.scheduledTasks ?? []).filter(
    (task) => task.status === 'active',
  ).length;

  // Always SideNavItem — expanded and collapsed. Astryx collapse context turns
  // these into icon-only slots without remounting a different control recipe
  // (which read as a squeeze when the rail previously swapped to IconButton).
  //
  // SideNavSection, like the footer below, rather than a bare fragment in a
  // product div: the section is what owns the space BETWEEN nav rows
  // (`items` → --spacing-0-5). Handed to `topContent` as a plain div these rows
  // were the only group on the rail outside that authority, so they stacked
  // edge to edge — invisible expanded, where the label separates the rows, and
  // plainly icons-as-one-slab at 48px. The header is hidden because the
  // rail landmark already names the panel; the title stays for a11y.
  return (
    <SideNavSection title={copy.mainLabel} isHeaderHidden className="maka-session-panel-top">
      <SideNavItem
        label={copy.newTask}
        icon={SquarePen}
        size="md"
        onClick={props.onNew}
        endContent={<kbd className="maka-nav-kbd" aria-hidden="true">⌘ N</kbd>}
      />
      {/* No 任务 row. Expanded, the list below IS that row's destination, and a
          control that selects what is already on screen under it is the same
          redundancy as the 会话 list heading this change deleted one row down.
          Collapsed, the list is not rendered — but the rail cannot switch tasks
          there either, so returning from 扩展 already means widening the rail,
          which the titlebar's 展开侧边栏 toggle does unconditionally
          (app-shell-chrome-actions.tsx) and which lands on a list where the
          task you left is still `activeId` and still marked. Adding a row to
          save that one click would be paying a permanent slot for a state the
          user is leaving anyway. */}
      <SideNavItem
        label={copy.extensions}
        icon={Blocks}
        size="md"
        isSelected={extensionsActive}
        onClick={() => props.onSelect({ section: 'extensions', module: moduleMemory.extensions })}
      />
      <SideNavItem
        label={activeScheduledTaskCount > 0
          ? copy.pendingTasks(activeScheduledTaskCount)
          : copy.automations}
        icon={Timer}
        size="md"
        isSelected={automationsActive}
        onClick={() => props.onSelect({ section: 'automations', module: moduleMemory.automations })}
      />
    </SideNavSection>
  );
}

/**
 * Only the two states that need the user.
 *
 * The updater runs with `autoDownload = true` and `autoInstallOnAppQuit =
 * false` (app-update-service.ts), so discovery and download ask nothing of
 * anyone — the shell drops `available` and `downloading` before they reach
 * here rather than the footer rendering a control for them. The old chip sat
 * in the footer through that whole silent phase counting bytes at someone who
 * had nothing to decide.
 */
export type SidebarUpdateReminder = {
  state: 'downloaded' | 'error';
  latestVersion: string;
};

/**
 * What build is running, shown where the user already looks to reach Settings.
 *
 * The About page has carried this since `PR-BUILD-HYGIENE-0`, but reaching it
 * takes two clicks and a scroll — so the question it answers ("is this the
 * release or the tree I just built?") is asked in the wrong place to be
 * answered by it. On the rail it costs a glance.
 *
 * `commit` is present only on a dev build (`build-info.ts` resolves it from
 * `.git/HEAD` and returns null once packaged), which is exactly when the
 * version number alone cannot distinguish two builds.
 */
export type SidebarBuildStamp = {
  version: string;
  commit?: string | null;
};

export function SessionSidebarFooter(props: {
  buildStamp?: SidebarBuildStamp;
  updateReminder?: SidebarUpdateReminder;
  onOpenSettings(): void;
  onOpenUpdate?(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).navigation;
  const reminder = props.updateReminder;
  // `v0.1.11` on a release, `v0.1.11 · a1b2c3d` on a dev build. Seven hex
  // characters is what `git log --oneline` shows and what a commit is quoted
  // as in review, so it is the form a reader can act on without reformatting.
  const stamp = props.buildStamp
    ? `v${props.buildStamp.version}${
        props.buildStamp.commit ? ` · ${props.buildStamp.commit.slice(0, 7)}` : ''
      }`
    : undefined;
  const updateAction = reminder && props.onOpenUpdate
    ? {
        // One sentence, serving as both the tooltip and the accessible name.
        // The button carries no visible text, so a bare verb ("Restart")
        // reaches a screen reader without saying restart what, or why now.
        label: reminder.state === 'downloaded'
          ? copy.updateDownloaded(reminder.latestVersion)
          : copy.updateFailed(reminder.latestVersion),
        // Download, and specifically NOT an up arrow: the composer's send
        // button is already an accent circle carrying a 16px ArrowUp
        // (composer.tsx), so an arrow here — in either direction — is the same
        // control drawn twice for two unrelated actions. The tray line under
        // this glyph is structure the send button has no counterpart for, so
        // the two stay apart without relying on the viewer comparing them.
        //
        // It reads as "download" even though the bytes are already on disk.
        // That matches what a user is deciding, which is whether to take the
        // new version; when the download finished is our bookkeeping, and the
        // downward arrow is the convention every app store made for exactly
        // this moment.
        icon: reminder.state === 'downloaded' ? Download : AlertCircle,
        onClick: props.onOpenUpdate,
      }
    : undefined;

  // Settings and the update action are SIBLINGS in a row, not one nested in
  // the other: SideNavItem renders `endContent` inside its own <button>, and
  // an <button> cannot contain a second one. This is the same split-action
  // shape SideNavItem itself falls back to when a row carries both a primary
  // action and a collapse toggle ("<div> row with <a> + <button> as siblings"
  // — SideNavItem.tsx), for exactly this reason.
  //
  // Collapsed, the rail is 48px and the label is gone; two controls cannot sit
  // side by side there, so the row stacks and the update button keeps its own
  // slot under settings instead of being dropped.
  return (
    <SideNavSection title={copy.settings} isHeaderHidden className="maka-session-panel-footer">
      <div className="maka-sidebar-footer-row">
        <div className="maka-sidebar-footer-row-primary">
          <SideNavItem
            label={copy.settings}
            icon={Settings}
            size="md"
            onClick={props.onOpenSettings}
          />
        </div>
        {stamp && (
          // Between Settings and the update button, not after it: the update
          // button is an action and keeps the edge, where a control is
          // reached. The stamp is a label — it reads on the way to that edge
          // and never moves when the button appears or goes away.
          <span className="maka-sidebar-build-stamp" title={copy.buildStamp(stamp)}>
            {stamp}
          </span>
        )}
        {updateAction && (
          <Tooltip content={updateAction.label}>
            <IconButton
              className="maka-sidebar-update-button"
              label={updateAction.label}
              icon={<Icon icon={updateAction.icon} size="sm" />}
              // `primary` resolves to the theme's own accent, so the button
              // follows Catppuccin and Tokyo Night instead of a hard-coded
              // blue. The previous chip reached for `--control` through
              // product CSS and had to hand-compute every hover and pressed
              // state in oklch(); none of that is restated here.
              variant={reminder?.state === 'error' ? 'secondary' : 'primary'}
              // `sm` (28px) against the settings row's 32px: a filled button
              // at the row's own height fills it edge to edge and competes
              // with it. Two pixels of air on each side is what makes it read
              // as something ON the row rather than a second row.
              size="sm"
              onClick={updateAction.onClick}
            />
          </Tooltip>
        )}
      </div>
    </SideNavSection>
  );
}

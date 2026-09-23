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

import type { WorkbarTogglePosition } from '@maka/core/settings';
import type { WorkbarHostModel } from './workbar-host';
import { Icon } from '@astryxdesign/core/Icon';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { IconButton, useUiLocale } from '@maka/ui';
import { PanelRightClose, PanelRightOpen } from '@maka/ui/icons';
import { getShellCopy } from '../../../locales/shell-copy';

/** The same control in the titlebar when collapsed and the panel when open. */
export function WorkbarToggle(props: {
  collapsed: boolean;
  onToggle(): void;
}) {
  const copy = getShellCopy(useUiLocale()).chrome;
  const label = props.collapsed ? copy.expandWorkbar : copy.collapseWorkbar;
  return (
    <Tooltip content={label}>
      <IconButton
        label={label}
        icon={(
          <Icon
            icon={props.collapsed ? PanelRightOpen : PanelRightClose}
            size="sm"
            color="secondary"
          />
        )}
        variant="ghost"
        size="sm"
        className="maka-titlebar-action"
        onClick={props.onToggle}
        aria-expanded={!props.collapsed}
      />
    </Tooltip>
  );
}

/** Titlebar restore affordance shown only while the Workbar is collapsed. */
export function WorkbarTitlebarActions(props: {
  model: Pick<WorkbarHostModel, 'activeId' | 'hidden' | 'rightCollapsed' | 'onToggleRightPanel'>;
  togglePosition: WorkbarTogglePosition;
}) {
  const copy = getShellCopy(useUiLocale()).chrome;
  if (props.togglePosition !== 'titlebar' || props.model.hidden || !props.model.activeId || !props.model.rightCollapsed) return null;

  return (
    <div
      className="maka-workspace-top-actions"
      role="toolbar"
      aria-label={copy.workspaceActions}
    >
      <WorkbarToggle collapsed onToggle={props.model.onToggleRightPanel} />
    </div>
  );
}

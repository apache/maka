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

import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import type { DropdownMenuItemData } from '@astryxdesign/core/DropdownMenu';
import { IconButton } from '@astryxdesign/core/IconButton';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { ArrowLeft, Folder } from './icons.js';
import { getConversationCopy } from './conversation-copy.js';
import { InlineRenameInput } from './inline-rename-input.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { useUiLocale } from './locale-context.js';

export interface TitlebarProject {
  name: string;
  path?: string;
  onOpenFolder?(): void;
}

export interface TitlebarParentSession {
  name: string;
  onOpen(): void;
}

export function TitlebarSessionIdentity(props: {
  sessionName: string;
  onRenameSession(name: string): void;
  project?: TitlebarProject;
  parentSession?: TitlebarParentSession;
  readOnly?: boolean;
  action?: { readonly label: string; onClick(): void };
}) {
  const copy = getConversationCopy(useUiLocale());
  const clipboard = useClipboardCopyFeedback(undefined, { redact: false });
  const [renaming, setRenaming] = useState(false);
  const nameRef = useRef<HTMLButtonElement>(null);
  const handBackFocusRef = useRef(false);

  function endRename(handBackFocus: boolean) {
    handBackFocusRef.current = handBackFocus;
    setRenaming(false);
  }

  useEffect(() => {
    if (renaming || !handBackFocusRef.current) return;
    handBackFocusRef.current = false;
    nameRef.current?.focus();
  }, [renaming]);

  const items: DropdownMenuItemData[] = [];
  if (!props.readOnly) {
    items.push({ label: copy.sessions.rename, onClick: () => setRenaming(true) });
  }
  if (props.action) {
    items.push({ label: props.action.label, onClick: props.action.onClick });
  }
  const projectItems: DropdownMenuItemData[] = [];
  if (props.project?.onOpenFolder) {
    projectItems.push({ label: copy.chat.openProjectFolderAction, onClick: props.project.onOpenFolder });
  }
  const path = props.project?.path;
  const copyPhase = path ? clipboard.phaseFor(path) : null;
  const copyLabel = copyPhase === 'failed' ? copy.messages.copyFailed
    : copyPhase === 'copied' ? copy.messages.copied : copy.chat.copyProjectPath;
  if (path) {
    projectItems.push({ label: copyLabel, onClick: () => { void clipboard.copy(path, path); } });
  }
  const projectContext = props.project
    ? [props.project.name, props.project.path !== props.project.name ? props.project.path : undefined]
        .filter(Boolean).join('\n')
    : undefined;

  const projectSection = projectContext ? [{ type: 'section' as const, title: projectContext, items: projectItems }] : [];
  const taskItems = props.parentSession ? [...items, ...projectSection] : items;

  return (
    <div className="maka-titlebar-identity" data-maka-contract="titlebar-identity" role="group" aria-label={copy.chat.titlebarIdentityAriaLabel}>
      {props.parentSession ? (
        <IconButton
          className="maka-titlebar-identity__action"
          label={copy.chat.openParentSession(props.parentSession.name)}
          tooltip={copy.chat.openParentSession(props.parentSession.name)}
          icon={<ArrowLeft size={14} />}
          variant="ghost"
          size="sm"
          onClick={props.parentSession.onOpen}
        />
      ) : props.project ? (
        <span className="maka-titlebar-identity__action">
          <MoreMenu
            className="maka-titlebar-menu"
            label={copy.chat.projectInfo}
            icon={<Folder size={14} />}
            size="sm"
            alignment="start"
            items={projectSection}
          />
        </span>
      ) : null}
      {renaming ? (
        <InlineRenameInput
          className="maka-titlebar-identity__rename-input"
          defaultValue={props.sessionName}
          ariaLabel={copy.sessions.renameAriaLabel}
          onCommit={(name, via) => {
            endRename(via === 'keyboard');
            if (name && name !== props.sessionName) props.onRenameSession(name);
          }}
          onCancel={() => endRename(true)}
        />
      ) : props.readOnly ? (
        <span className="maka-titlebar-identity__name maka-titlebar-identity__segment--session" title={props.sessionName}>
          {props.sessionName}
        </span>
      ) : (
        <Button
          ref={nameRef}
          className="maka-titlebar-identity__name"
          label={`${props.sessionName} — ${copy.sessions.renameAriaLabel}`}
          tooltip={`${props.sessionName} — ${copy.sessions.renameAriaLabel}`}
          variant="ghost"
          size="sm"
          onClick={() => setRenaming(true)}
        >
          <span className="maka-titlebar-identity__segment--session">{props.sessionName}</span>
        </Button>
      )}
      {taskItems.length > 0 ? (
        <span className="maka-titlebar-identity__action">
          <MoreMenu
            className="maka-titlebar-menu"
            label={copy.sessions.actionsAriaLabel(props.sessionName)}
            size="sm"
            alignment="end"
            items={taskItems}
          />
        </span>
      ) : null}
      <span className="maka-visually-hidden" role="status">{copyPhase === 'failed' || copyPhase === 'copied' ? copyLabel : null}</span>
    </div>
  );
}

// The menu names a registered project, falling back to the session directory.
export function deriveTitlebarProjectName(options: {
  projectName?: string;
  projectPath?: string;
}): string | undefined {
  if (options.projectName) return options.projectName;
  const path = options.projectPath?.replace(/[/\\]+$/, '');
  if (!path) return undefined;
  return path.split(/[/\\]/).pop() || undefined;
}

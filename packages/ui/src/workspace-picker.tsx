/**
 * Workspace picker (issue #1044) — the control that decides which project a
 * NEW chat starts in.
 *
 * It lives on the empty-chat canvas, under the hero greeting and above the
 * composer, because that is where its lifetime belongs. The project is a
 * session-creation parameter: it is fixed the moment the first message creates
 * the session, and no other entry point changes it afterwards. The composer's
 * footer control row, where this used to sit, holds controls that persist for
 * the whole session (＋, the permission shield, the model), so a chip that
 * vanishes on send broke that row's implicit contract. On the hero it leaves
 * with the surface it belongs to.
 *
 * Reading order follows decision order: greeting → where → what.
 *
 * The current git branch rides along as read-only trigger context (tooltip and
 * accessible name). Switching branches is the agent's job — see the commit that
 * removed the branch picker.
 *
 * Purely presentational: a standard compact menu trigger fed by host-injected
 * props. Shared Button owns its visual and interaction states; local classes
 * only constrain layout and label truncation.
 */

import type { ProjectRecord } from '@maka/core';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Divider } from '@astryxdesign/core/Divider';
import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, FolderOpen, Plus } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface WorkspacePickerModel {
  label?: string;
  branch?: string | null;
  pending?: boolean;
  defaultOpen?: boolean;
  projects: readonly ProjectRecord[];
  selectedProjectId?: string | null;
  onAdd(): void;
  onSelectProject(projectId: string): void;
  onRelink(projectId: string): void;
  onSelectNoProject(): void;
}

export function WorkspacePicker(props: { workspacePicker: WorkspacePickerModel }) {
  const wp = props.workspacePicker;
  const copy = getConversationCopy(useUiLocale()).workspace;
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(
    wp.defaultOpen ?? false,
  );
  return (
    /* The trigger sits high on the canvas with the composer below it, so the
       menu opens downward, over that content. Opening 'above' here would drop
       it into the empty upper canvas — the anchoring complaint that moved
       these controls off their old bar above the card in the first place. */
    <DropdownMenu
      isMenuOpen={workspaceMenuOpen}
      onOpenChange={setWorkspaceMenuOpen}
      placement="below"
      button={{
        label: copy.chooseAriaLabel(
          wp.label ?? copy.current,
          wp.branch ?? undefined,
        ),
        icon: <FolderOpen size={13} aria-hidden="true" />,
        endContent: <ChevronDown size={12} aria-hidden="true" />,
        variant: 'ghost',
        size: 'sm',
        className: 'maka-workspace-picker',
        isDisabled: wp.pending === true,
        'aria-busy': wp.pending === true ? 'true' : undefined,
        tooltip: copy.chooseTitle(wp.branch ?? undefined),
        children: wp.label
          ? <span className="maka-workspace-picker-current">{wp.label}</span>
          : copy.choose,
      }}
      className="maka-workspace-picker-menu"
    >
      <div className="maka-workspace-picker-scroll">
        {wp.projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            onClick={() => {
              if (project.available) wp.onSelectProject(project.id);
              else wp.onRelink(project.id);
            }}
            icon={project.available
              ? <FolderOpen size={13} aria-hidden="true" />
              : <AlertTriangle size={13} aria-hidden="true" />}
            label={project.name}
            endContent={!project.available
              ? <span className="maka-workspace-picker-status">{copy.relink}</span>
              : project.id === wp.selectedProjectId ? (
                <Check size={12} aria-hidden="true" className="maka-workspace-picker-check" />
              ) : undefined}
          />
        ))}
      </div>
      <Divider orientation="horizontal" />
      <DropdownMenuItem
        onClick={() => {
          wp.onAdd();
        }}
        icon={<Plus size={13} aria-hidden="true" />}
        label={copy.addProject}
      />
      <Divider orientation="horizontal" />
      <DropdownMenuItem
        className="maka-workspace-picker-none"
        onClick={() => {
          wp.onSelectNoProject();
        }}
        label={copy.noProject}
        endContent={wp.selectedProjectId === null ? (
          <Check size={12} aria-hidden="true" className="maka-workspace-picker-check" />
        ) : undefined}
      />
    </DropdownMenu>
  );
}

/**
 * Composer workspace picker (issue #1044) — the control that decides where a
 * NEW chat starts. It lives in the composer card's footer control row, beside
 * the model chip, and speaks the same quiet chip dialect as the ＋ menu, the
 * permission shield and the model picker.
 *
 * It renders as a bare child rather than inside a wrapper: the control row
 * owns the gap, so a wrapper would introduce a second spacing authority and
 * group it apart from the controls it belongs with. It used to sit in exactly
 * such a wrapper on a lone bar above the card, which is what made it read as a
 * leftover rather than part of the control surface.
 *
 * The current git branch rides along as read-only trigger context (tooltip and
 * accessible name). Switching branches is the agent's job, not a menu's: a
 * checkout rewrites the user's real working tree, and the control that offered
 * it only existed before the first message — see the PR that removed it.
 *
 * Purely presentational: the picker is a standard compact menu trigger fed by
 * host-injected props. Shared Button owns its visual and interaction states;
 * local classes only constrain layout and label truncation.
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

export interface ComposerWorkspacePicker {
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

export function ComposerWorkspacePickers(props: {
  workspacePicker: ComposerWorkspacePicker;
}) {
  const wp = props.workspacePicker;
  const copy = getConversationCopy(useUiLocale()).workspace;
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(
    wp.defaultOpen ?? false,
  );
  return (
    /* The workspace picker is a standard compact menu trigger. Shared Button
       owns its visual and interaction states; local classes only constrain
       layout and label truncation. */
    <DropdownMenu
      isMenuOpen={workspaceMenuOpen}
      onOpenChange={setWorkspaceMenuOpen}
      placement="above"
      button={{
        label: copy.chooseAriaLabel(
          wp.label ?? copy.current,
          wp.branch ?? undefined,
        ),
        icon: <FolderOpen size={13} aria-hidden="true" />,
        endContent: <ChevronDown size={12} aria-hidden="true" />,
        variant: 'ghost',
        size: 'sm',
        className: 'maka-composer-workspace-picker',
        isDisabled: wp.pending === true,
        'aria-busy': wp.pending === true ? 'true' : undefined,
        tooltip: copy.chooseTitle(wp.branch ?? undefined),
        children: wp.label
          ? <span className="maka-composer-workspace-current">{wp.label}</span>
          : copy.choose,
      }}
      className="maka-composer-workspace-menu"
    >
      <div className="maka-composer-project-scroll">
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
              ? <span className="maka-composer-project-status">{copy.relink}</span>
              : project.id === wp.selectedProjectId ? (
                <Check size={12} aria-hidden="true" className="maka-composer-project-check" />
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
        className="maka-composer-no-project"
        onClick={() => {
          wp.onSelectNoProject();
        }}
        label={copy.noProject}
        endContent={wp.selectedProjectId === null ? (
          <Check size={12} aria-hidden="true" className="maka-composer-project-check" />
        ) : undefined}
      />
    </DropdownMenu>
  );
}

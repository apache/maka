/**
 * Composer workspace + git branch pickers (issue #1044) — the two controls
 * that decide where a NEW chat starts. They live in the composer card's
 * footer control row, beside the model chip, and speak the same quiet chip
 * dialect as the ＋ menu, the permission shield and the model picker.
 *
 * They render as bare siblings rather than inside a wrapper: the control row
 * owns the gap, so a wrapper would introduce a second spacing authority and
 * group these two apart from the controls they belong with. They used to sit
 * in exactly such a wrapper on a lone bar above the card, which is what made
 * them read as leftovers rather than part of the control surface.
 *
 * Purely presentational: both pickers are standard compact menu triggers fed
 * by host-injected props. Shared Button owns their visual and interaction
 * states; local classes only constrain layout and label truncation.
 */

import type { ProjectRecord } from '@maka/core';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Divider } from '@astryxdesign/core/Divider';
import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, FolderOpen, GitBranch, Plus } from './icons.js';
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

/**
 * Git branch picker, shown to the right of the folder indicator when the
 * workspace is a git repository. Clicking the trigger opens a Menu listing
 * local branches; selecting one fires `onSelect` to switch branches (handled
 * in the shell).
 */
export interface ComposerBranchPicker {
  branch: string | null;
  pending?: boolean;
  branches: string[];
  onOpen(): void;
  onSelect(branch: string): void;
}

export function ComposerWorkspacePickers(props: {
  workspacePicker: ComposerWorkspacePicker;
  branchPicker?: ComposerBranchPicker;
}) {
  const wp = props.workspacePicker;
  const copy = getConversationCopy(useUiLocale()).workspace;
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(
    wp.defaultOpen ?? false,
  );
  return (
    <>
      {/* The workspace and branch pickers are standard compact menu
          triggers. Shared Button owns their visual and interaction states;
          local classes only constrain layout and label truncation. */}
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
      {props.branchPicker && (() => {
        const bp = props.branchPicker!;
        const triggerDisabled = bp.pending === true;
        return (
          <DropdownMenu
            onClick={bp.onOpen}
            placement="above"
            button={{
              label: copy.branchAriaLabel(bp.branch ?? undefined),
              icon: <GitBranch size={13} aria-hidden="true" />,
              endContent: <ChevronDown size={12} aria-hidden="true" />,
              variant: 'ghost',
              size: 'sm',
              className: 'maka-composer-branch-picker',
              isDisabled: triggerDisabled,
              'aria-busy': triggerDisabled ? 'true' : undefined,
              tooltip: copy.branchTitle(bp.branch ?? undefined),
              children: (
                <span className="maka-composer-branch-current">
                  {bp.branch ?? '—'}
                </span>
              ),
            }}
            className="maka-composer-branch-menu"
          >
              {bp.branches.length === 0 ? (
                <div className="maka-composer-branch-empty">{copy.noBranches}</div>
              ) : (
                bp.branches.map((b) => (
                  <DropdownMenuItem
                    key={b}
                    onClick={() => {
                      if (b === bp.branch) return;
                      void bp.onSelect(b);
                    }}
                    icon={<GitBranch size={13} aria-hidden="true" />}
                    label={b}
                    endContent={b === bp.branch ? (
                      <Check size={12} aria-hidden="true" className="maka-composer-branch-check" />
                    ) : undefined}
                  />
                ))
              )}
          </DropdownMenu>
        );
      })()}
    </>
  );
}

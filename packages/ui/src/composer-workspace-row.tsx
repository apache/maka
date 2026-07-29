/**
 * Composer workspace row (issue #1044) — the workspace picker + git branch
 * picker rendered below the composer card. Extracted from `composer.tsx`;
 * purely presentational: both pickers are standard compact menu triggers fed
 * by host-injected props. Shared Button owns their visual and interaction
 * states; local classes only constrain layout and label truncation.
 */

import type { ProjectRecord } from '@maka/core';
import { AlertTriangle, Check, ChevronDown, FolderOpen, GitBranch, Plus } from './icons.js';
import { Button as UiButton } from './ui.js';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './primitives/menu.js';
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
 * Git branch picker for the workspace row, shown to the right of
 * the folder indicator when the workspace is a git repository.
 * Clicking the trigger opens a Menu listing local branches; selecting
 * one fires `onSelect` to switch branches (handled in the shell).
 */
export interface ComposerBranchPicker {
  branch: string | null;
  pending?: boolean;
  branches: string[];
  onOpen(): void;
  onSelect(branch: string): void;
}

export function ComposerWorkspaceRow(props: {
  workspacePicker: ComposerWorkspacePicker;
  branchPicker?: ComposerBranchPicker;
}) {
  const wp = props.workspacePicker;
  const copy = getConversationCopy(useUiLocale()).workspace;
  return (
    <div className="maka-composer-workspace-row">
      {/* The workspace and branch pickers are standard compact menu
          triggers. Shared Button owns their visual and interaction states;
          local classes only constrain layout and label truncation. */}
      <Menu defaultOpen={wp.defaultOpen}>
        <MenuTrigger
          render={({ onClick: menuToggleClick, ...triggerRest }) => (
            <UiButton
              {...triggerRest}
              onClick={(e) => {
                menuToggleClick?.(e);
              }}
              type="button"
              variant="quiet"
              size="sm"
              className="maka-composer-workspace-picker"
              disabled={wp.pending === true}
              aria-busy={wp.pending === true ? 'true' : undefined}
              title={copy.chooseTitle(wp.branch ?? undefined)}
              // The name says what the control does; the selected project is the
              // control's content, which the platform reports separately. Naming
              // it `选择项目：kami-report` meant the name changed every time the
              // user picked a project — so whoever had just picked one could no
              // longer refer to the thing they picked it with.
              // docs/accessibility-governance.md §1.
              aria-label={copy.choose}
              aria-describedby={wp.label ? 'maka-composer-workspace-value' : undefined}
            >
              <FolderOpen size={13} aria-hidden="true" />
              {wp.label
                ? (
                  <span id="maka-composer-workspace-value" className="maka-composer-workspace-current">
                    {wp.label}
                  </span>
                )
                : <span>{copy.choose}</span>}
              <ChevronDown size={12} aria-hidden="true" />
            </UiButton>
          )}
        />
        <MenuPopup className="maka-composer-workspace-menu" align="start" side="top" sideOffset={6}>
          <div className="maka-composer-project-scroll">
            {wp.projects.map((project) => (
              <MenuItem
                key={project.id}
                data-active={project.id === wp.selectedProjectId}
                onClick={() => {
                  if (project.available) wp.onSelectProject(project.id);
                  else wp.onRelink(project.id);
                }}
              >
                {project.available
                  ? <FolderOpen size={13} aria-hidden="true" />
                  : <AlertTriangle size={13} aria-hidden="true" />}
                <span>{project.name}</span>
                {!project.available && <span className="maka-composer-project-status">{copy.relink}</span>}
                {project.id === wp.selectedProjectId && project.available && (
                  <Check size={12} aria-hidden="true" className="maka-composer-project-check" />
                )}
              </MenuItem>
            ))}
          </div>
          <MenuSeparator />
          <MenuItem onClick={() => { wp.onAdd(); }}>
            <Plus size={13} aria-hidden="true" />
            <span>{copy.addProject}</span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem className="maka-composer-no-project" onClick={() => { wp.onSelectNoProject(); }}>
            <span>{copy.noProject}</span>
            {wp.selectedProjectId === null && (
              <Check size={12} aria-hidden="true" className="maka-composer-project-check" />
            )}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {props.branchPicker && (() => {
        const bp = props.branchPicker!;
        const triggerDisabled = bp.pending === true;
        return (
          <Menu>
            <MenuTrigger
              render={({ onClick: menuToggleClick, ...triggerRest }) => (
                <UiButton
                  {...triggerRest}
                  onClick={(e) => {
                    bp.onOpen();
                    menuToggleClick?.(e);
                  }}
                  type="button"
                  variant="quiet"
                  size="sm"
                  className="maka-composer-branch-picker"
                  disabled={triggerDisabled}
                  aria-busy={triggerDisabled ? 'true' : undefined}
                  title={copy.branchTitle(bp.branch ?? undefined)}
                  // Same shape as the project picker above: the name says what
                  // pressing does, the branch is content the platform reports on
                  // its own. docs/accessibility-governance.md §1.
                  aria-label={copy.branch}
                  aria-describedby={bp.branch ? 'maka-composer-branch-value' : undefined}
                >
                  <GitBranch size={13} aria-hidden="true" />
                  <span id="maka-composer-branch-value" className="maka-composer-branch-current">
                    {bp.branch ?? '—'}
                  </span>
                  <ChevronDown size={12} aria-hidden="true" />
                </UiButton>
              )}
            />
            <MenuPopup className="maka-composer-branch-menu" align="start" side="top" sideOffset={6}>
              {bp.branches.length === 0 ? (
                <div className="maka-composer-branch-empty">{copy.noBranches}</div>
              ) : (
                bp.branches.map((b) => (
                  <MenuItem
                    key={b}
                    data-active={b === bp.branch}
                    onClick={() => {
                      if (b === bp.branch) return;
                      void bp.onSelect(b);
                    }}
                  >
                    <GitBranch size={13} aria-hidden="true" />
                    <span>{b}</span>
                    {b === bp.branch && (
                      <Check size={12} aria-hidden="true" className="maka-composer-branch-check" />
                    )}
                  </MenuItem>
                ))
              )}
            </MenuPopup>
          </Menu>
        );
      })()}
    </div>
  );
}

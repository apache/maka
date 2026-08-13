/**
 * Workspace picker (issue #1044) — the control that decides which project a
 * NEW chat starts in.
 *
 * It sits at the end of the composer footer's send-context group — after the
 * model and thinking pickers — and only while no session owns the composer. The
 * project is a session-creation parameter: it is fixed the moment the first
 * message creates the session, and no other entry point changes it afterwards.
 *
 * That group is the right company for it: model, thinking level and permission
 * mode are all parameters of the send about to happen, and so is the project.
 * Last in the group is what makes its shorter life cheap — when the first
 * message unmounts it, nothing to its left moves.
 *
 * Two other homes were tried. The empty-chat HERO, under the greeting, fixed
 * the lifetime but floated the control in the gap between the greeting and the
 * card, belonging to neither. The composer's HEADER row above the input kept it
 * on the card, but grew the card by a whole row for the draft state alone —
 * a layout jump on every new task, paid to avoid one chip disappearing from the
 * end of a row.
 *
 * Built on the composer footer's ghost-button DropdownMenu family — the same
 * primitive as the model, thinking, ＋ and permission controls beside it —
 * because this row is a toolbar, and toolbar members share one Button chrome:
 * resting, hover, focus, and disabled states plus the tooltip all derive from
 * Astryx Button instead of a product overlay restyling a form field. It used
 * to be an Astryx Selector (rebuilt onto it in #2217, when the model picker
 * beside it was one too); #2230 moved the model and thinking pickers onto the
 * ghost-menu family, and this control followed once the row had one toolbar
 * convention left. Search died with the Selector, matching the model menu's
 * precedent: the menu keeps Astryx's first-character typeahead over printable
 * keys, which for CJK labels means arrow traversal in practice — IME input
 * does not produce the keydown events typeahead listens for. The catalogue
 * scrolls inside its own region, and the two actions after it sit outside the
 * scroller, so the wheel can never carry them away. The trigger's tooltip
 * came back with the Button: Selector had no slot for it, so the current git
 * branch rode in the accessible name alone.
 *
 * The current git branch rides in the trigger's tooltip and accessible name
 * only — the open menu's own name is the short trigger label, an Astryx
 * behaviour the model menu shares. Switching branches is the agent's job —
 * see the commit that removed the branch picker.
 *
 * Purely presentational: a value control fed by host-injected props.
 */

import type { ProjectRecord } from '@maka/core/project';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu';
import { useMemo } from 'react';
import { ICON_SIZE, AlertTriangle, Check, FolderOpen, Plus, X } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface WorkspacePickerModel {
  label?: string;
  branch?: string | null;
  pending?: boolean;
  projects: readonly ProjectRecord[];
  selectedProjectId?: string | null;
  onAdd?(): void;
  onSelectProject(projectId: string): void;
  onRelink?(projectId: string): void;
  onSelectNoProject?(): void;
}

export function WorkspacePicker(props: { workspacePicker: WorkspacePickerModel }) {
  const wp = props.workspacePicker;
  const copy = getConversationCopy(useUiLocale()).workspace;

  const unavailable = useMemo(
    () => new Set(wp.projects.filter((project) => !project.available).map((project) => project.id)),
    [wp.projects],
  );

  // A project switch is in flight: lock the trigger and every row, like the
  // model switcher beside it — an aria-disabled DropdownMenu trigger still
  // opens on ArrowDown, so the lock must ride on the items too.
  const locked = wp.pending === true;

  return (
    <DropdownMenu
      placement="above"
      hasChevron={false}
      className="maka-composer-quiet-menu"
      button={{
        label: wp.label ?? copy.choose,
        icon: <FolderOpen size={ICON_SIZE.meta} aria-hidden="true" />,
        variant: 'ghost',
        size: 'sm',
        isDisabled: locked,
        isLoading: locked,
        tooltip: copy.chooseTitle(wp.branch ?? undefined),
        className: 'maka-workspace-picker',
        'aria-label': copy.chooseAriaLabel(wp.label ?? copy.current, wp.branch ?? undefined),
      }}
    >
      {/* Catalogue first, in its own scroll region — the only thing that
          scrolls. The two actions sit AFTER it in normal flow, so they are
          outside the scroller entirely and cannot be carried along by it: the
          old sticky-pinned box moved with the panel when overscroll chained
          to the page behind the menu. The region renders only when there is a
          catalogue; on first run the actions group is the menu's first child
          and the CSS drops the divider that separates the two. */}
      {wp.projects.length > 0 ? (
        <div className="maka-workspace-picker-scroll">
          {wp.projects.map((project) => {
            const missing = unavailable.has(project.id);
            return (
              <DropdownMenuItem
                key={project.id}
                icon={
                  missing ? (
                    <AlertTriangle size={ICON_SIZE.meta} aria-hidden="true" />
                  ) : (
                    <FolderOpen size={ICON_SIZE.meta} aria-hidden="true" />
                  )
                }
                label={project.name}
                // A project whose directory has moved cannot be selected until
                // it is pointed at a path again, so its row relinks instead of
                // switching. The current project wears the same plain check as
                // the model and thinking menus' current values.
                endContent={
                  missing ? (
                    <span className="maka-workspace-picker-status">
                      {wp.onRelink ? copy.relink : copy.unavailable}
                    </span>
                  ) : project.id === wp.selectedProjectId ? (
                    <Check size={ICON_SIZE.control} aria-hidden="true" />
                  ) : undefined
                }
                onClick={() => {
                  if (missing) wp.onRelink?.(project.id);
                  else wp.onSelectProject(project.id);
                }}
                isDisabled={locked || (missing && !wp.onRelink)}
              />
            );
          })}
        </div>
      ) : null}
      {/* Available target-level actions carry an icon so every row shares one
          text axis. Their absence is authority, not a disabled local action. */}
      {wp.onAdd || wp.onSelectNoProject ? <div role="group">
        {wp.onAdd ? <DropdownMenuItem
          icon={<Plus size={ICON_SIZE.meta} aria-hidden="true" />}
          label={copy.addProject}
          isDisabled={locked}
          onClick={() => {
            wp.onAdd?.();
          }}
        /> : null}
        {wp.onSelectNoProject ? <DropdownMenuItem
          icon={<X size={ICON_SIZE.meta} aria-hidden="true" />}
          label={copy.noProject}
          endContent={wp.selectedProjectId === null ? <Check size={ICON_SIZE.control} aria-hidden="true" /> : undefined}
          isDisabled={locked}
          onClick={() => {
            wp.onSelectNoProject?.();
          }}
        /> : null}
      </div> : null}
    </DropdownMenu>
  );
}

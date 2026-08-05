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
 * Built on Astryx `Selector`, the same primitive as the model picker, because
 * picking a project IS choosing a value: one selection out of a catalogue,
 * with a current one. It used to be a `DropdownMenu` — an action menu — which
 * it could only be because the catalogue and the actions (add, relink, no
 * project) shared one surface. That choice was visible: menu items came out at
 * weight 400 in `#171717` next to the model list's weight 500 in the theme's
 * oklch foreground, two dropdowns from one library that did not read as
 * relatives. The actions are now ordinary options after a divider, following
 * `ModelPicker`'s `leadingOption` precedent for product values that are not
 * catalogue entries.
 *
 * The current git branch rides along in the trigger's accessible name only.
 * Switching branches is the agent's job — see the commit that removed the
 * branch picker.
 *
 * Purely presentational: a value control fed by host-injected props.
 */

import type { ProjectRecord } from '@maka/core';
import { Selector, SelectorOption, type SelectorOptionData, type SelectorOptionType } from '@astryxdesign/core/Selector';
import { useMemo } from 'react';
import { AlertTriangle, FolderOpen, Plus, X } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface WorkspacePickerModel {
  label?: string;
  branch?: string | null;
  pending?: boolean;
  projects: readonly ProjectRecord[];
  selectedProjectId?: string | null;
  onAdd(): void;
  onSelectProject(projectId: string): void;
  onRelink(projectId: string): void;
  onSelectNoProject(): void;
}

/**
 * Sentinel option values for the two entries that are not projects. Namespaced
 * so they can never collide with a real project id.
 */
const ADD_PROJECT_VALUE = 'maka:workspace/add-project';
const NO_PROJECT_VALUE = 'maka:workspace/no-project';

export function WorkspacePicker(props: { workspacePicker: WorkspacePickerModel }) {
  const wp = props.workspacePicker;
  const copy = getConversationCopy(useUiLocale()).workspace;

  const unavailable = useMemo(
    () => new Set(wp.projects.filter((project) => !project.available).map((project) => project.id)),
    [wp.projects],
  );

  // Catalogue first, then the two actions — which stay pinned to the menu's
  // bottom edge while only the catalogue scrolls, so "add a project" never
  // falls under the fold on a long list. Selector scrolls its whole list as one
  // region and has no footer slot, so the pinning is done in CSS; what makes it
  // one rule instead of a stack of them is the section, which Selector renders
  // as a single `role="group"` box. `composer.css` sticks that box, and its
  // height is whatever it actually contains — so a search that matches only one
  // action pins exactly that row.
  //
  // Both actions carry an icon so every row shares one text axis. Without them
  // the two labels started at the icon column while the projects' text started
  // past it, which read as a broken list rather than as a separate group.
  const options = useMemo<SelectorOptionType[]>(
    () => [
      ...wp.projects.map((project): SelectorOptionData => ({
        value: project.id,
        label: project.name,
      })),
      // The rule that separates the catalogue from the actions is the group's
      // own top border, not a divider option: a divider would scroll away with
      // the catalogue while the group stayed, and it would need suppressing on
      // first run — no projects yet — where it would divide nothing. The border
      // is on the box that is always there, and CSS drops it when the group is
      // the list's first child.
      {
        type: 'section',
        options: [
          { value: ADD_PROJECT_VALUE, label: copy.addProject },
          // Codex names this row "work without a project", which says the act
          // rather than the empty value. Not adopted: Selector paints the
          // trigger from the selected option's own label, with no slot to
          // shorten it, so that phrasing would also become the label sitting in
          // the composer footer — a seven-character negative sentence beside
          // the model name. The × carries the same "deliberate, not missing"
          // meaning at trigger length.
          { value: NO_PROJECT_VALUE, label: copy.noProject },
        ],
      },
    ],
    [wp.projects, copy.addProject, copy.noProject],
  );

  return (
    <Selector
      label={copy.chooseAriaLabel(wp.label ?? copy.current, wp.branch ?? undefined)}
      isLabelHidden
      options={options}
      // `null` means "no project", which is a real choice here rather than the
      // absence of one, so it maps to its own option instead of the placeholder.
      value={wp.selectedProjectId ?? NO_PROJECT_VALUE}
      // Always searchable, like the model picker: a threshold would make the
      // menu change shape as the catalogue grows, so the same control would
      // answer the keyboard differently on different days.
      hasSearch
      searchPlaceholder={copy.searchPlaceholder}
      size="sm"
      // The trigger sits in the composer footer, at the bottom of the window,
      // so the menu opens upward like every other control in that row.
      placement="above"
      isDisabled={wp.pending === true}
      startIcon={<FolderOpen size={13} aria-hidden="true" />}
      className="maka-workspace-picker"
      changeAction={(value: string) => {
        if (value === ADD_PROJECT_VALUE) {
          wp.onAdd();
          return;
        }
        if (value === NO_PROJECT_VALUE) {
          wp.onSelectNoProject();
          return;
        }
        // A project whose directory has moved cannot be selected until it is
        // pointed at a path again, so its row relinks instead of switching.
        if (unavailable.has(value)) wp.onRelink(value);
        else wp.onSelectProject(value);
      }}
      renderOption={(option: SelectorOptionData) => (
        <SelectorOption
          className={
            option.value === ADD_PROJECT_VALUE || option.value === NO_PROJECT_VALUE
              ? 'maka-workspace-picker-option maka-workspace-picker-option-pinned'
              : 'maka-workspace-picker-option'
          }
          icon={
            option.value === ADD_PROJECT_VALUE
              ? <Plus size={13} aria-hidden="true" />
              : option.value === NO_PROJECT_VALUE
                ? <X size={13} aria-hidden="true" />
                : unavailable.has(option.value)
                  ? <AlertTriangle size={13} aria-hidden="true" />
                  : <FolderOpen size={13} aria-hidden="true" />
          }
          label={option.label ?? option.value}
          endContent={unavailable.has(option.value) ? (
            <span className="maka-workspace-picker-status">{copy.relink}</span>
          ) : undefined}
        />
      )}
    />
  );
}

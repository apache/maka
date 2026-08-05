/**
 * Workspace picker (issue #1044) — the control that decides which project a
 * NEW chat starts in.
 *
 * It lives in the composer's header row, above the input, and only while the
 * chat is a draft. The project is a session-creation parameter: it is fixed the
 * moment the first message creates the session, and no other entry point
 * changes it afterwards — so the row it sits in is passed only in that state
 * and leaves with it.
 *
 * Two placements were tried and rejected. The composer's FOOTER row, where this
 * originally sat, holds controls that persist for the whole session (＋, the
 * permission shield, the model); a chip that vanishes on send broke that row's
 * implicit contract. The empty-chat HERO, under the greeting, fixed the
 * lifetime but floated the control in the gap between the greeting and the
 * card, belonging to neither. The header row belongs to the card the user is
 * about to type in, and stays clear of the persistent controls below it.
 *
 * Reading order still follows decision order: where → what.
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
 * The current git branch rides along as read-only trigger context (tooltip and
 * accessible name). Switching branches is the agent's job — see the commit that
 * removed the branch picker.
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
  defaultOpen?: boolean;
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

  // Catalogue first, then the two actions after a divider — and the actions
  // stay pinned to the menu's bottom edge while only the catalogue scrolls, so
  // "add a project" never falls under the fold on a long list. Selector scrolls
  // its whole list as one region and has no footer slot, so the pinning is done
  // in CSS: these two rows are marked here and `hero.css` sticks them. See the
  // sticky block there for why the backdrop is painted by the list rather than
  // by the rows.
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
      // A divider separates the catalogue from the pinned actions, so on first
      // run — no projects yet — it would open the menu with a rule above its
      // first row, dividing nothing. The two actions carry no rule between
      // them: pinned together against the scrolling catalogue they already read
      // as one footer, and a second rule inside a two-row block is noise.
      ...(wp.projects.length > 0 ? [{ type: 'divider' } as const] : []),
      { value: ADD_PROJECT_VALUE, label: copy.addProject },
      // Codex names this row "work without a project", which says the act
      // rather than the empty value. Not adopted: Selector paints the trigger
      // from the selected option's own label, with no slot to shorten it, so
      // that phrasing would also become the label sitting alone under the
      // greeting — a seven-character negative sentence as the calmest surface
      // in the product. The × carries the same "deliberate, not missing"
      // meaning at trigger length.
      { value: NO_PROJECT_VALUE, label: copy.noProject },
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
      // The trigger sits in the composer's header, near the bottom of the
      // window, so the menu opens upward into the canvas the draft state leaves
      // empty. Downward it would cover the input the user is about to type in,
      // and on a short window it would run past the frame.
      placement="above"
      isDefaultOpen={wp.defaultOpen}
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

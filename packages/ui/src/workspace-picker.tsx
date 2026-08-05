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

  // Catalogue first, then the two actions after a divider. The DropdownMenu
  // this replaced pinned them below a scrolling catalogue so they stayed on
  // screen; Selector scrolls as one list, so a long catalogue now pushes them
  // under the fold. That is the right trade: switching projects is the common
  // act and stays at the top, adding one is rare, and search reaches any row —
  // including these — faster than scrolling did.
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
      // A divider separates the catalogue from the actions, so on first run —
      // no projects yet — it would open the menu with a rule above its first
      // row, dividing nothing.
      ...(wp.projects.length > 0 ? [{ type: 'divider' } as const] : []),
      { value: ADD_PROJECT_VALUE, label: copy.addProject },
      { type: 'divider' },
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
      // The trigger sits high on the canvas with the composer below it, so the
      // menu opens downward, over that content. Opening 'above' here would drop
      // it into the empty upper canvas — the anchoring complaint that moved
      // these controls off their old bar above the card in the first place.
      placement="below"
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
          className="maka-workspace-picker-option"
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

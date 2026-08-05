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
import { AlertTriangle, FolderOpen } from './icons.js';
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

/**
 * The scroll region this replaced was 224px — about eight rows. Below that the
 * catalogue fits on one screen and a search field is a box to skip past; above
 * it, scanning starts to cost more than typing. `ModelPicker` searches
 * unconditionally because a provider catalogue is long by construction.
 */
const SEARCH_THRESHOLD = 8;

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
  // act and stays at the top, adding one is rare, and past SEARCH_THRESHOLD
  // typing reaches any row — including these — faster than scrolling did.
  const options = useMemo<SelectorOptionType[]>(
    () => [
      ...wp.projects.map((project): SelectorOptionData => ({
        value: project.id,
        label: project.name,
      })),
      { type: 'divider' },
      { value: ADD_PROJECT_VALUE, label: copy.addProject },
      { type: 'divider' },
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
      hasSearch={wp.projects.length >= SEARCH_THRESHOLD}
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
            option.value === ADD_PROJECT_VALUE || option.value === NO_PROJECT_VALUE
              ? undefined
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

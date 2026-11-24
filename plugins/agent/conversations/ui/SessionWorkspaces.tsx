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

import { Text, View, cleanup, computed, effect, signal, windowSize } from 'nsh';
import type { InputRef, JSX } from 'nsh';
import { Button, Command, Input, Popover, Select } from 'nsh/base';
import type { ServiceMethods } from '../../../../packages/plugin-sdk/src/generated/methods.js';
import type { BrowserProject } from '../../../../products/maka/workbench/app/browsing';
import type { Host } from '../../../../products/maka/workbench/app/host';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { tr, type MessageKey } from '../../../../products/maka/workbench/app/locale';
import {
  DialogFooter,
  DialogHeader,
  ModalDialog,
} from '../../../../products/maka/workbench/app/ModalDialog';
import { formatCount } from '../../../../products/maka/workbench/app/numberFormat';
import type { RecentWorkspace } from '../../../../products/maka/workbench/app/RecentWorkspaces';
import { basenameLabel } from '../../../../products/maka/workbench/app/reviewState';
import { SettingsButton } from '../../../../products/maka/workbench/app/SettingsPage';
import { createText, errorText, UiError } from '../../../../products/maka/workbench/app/text';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  floatingStyle,
  inputBorderRadius,
  inputTextStyle,
  menuDetailTextStyle,
  menuLabelStyle,
  menuRowStyle,
  menuRowHoverStyle,
  menuSeparatorStyle,
  quietFocusStyle,
  textTooltip,
} from '../../../../products/maka/workbench/app/ui';

type WorktreeResult = ServiceMethods['agent']['projectWorktrees']['output'];
type BranchCheckout = ServiceMethods['agent']['checkoutProjectBranch'];
type Repository = Extract<WorktreeResult, { kind: 'git' }>;
type Branch = Repository['branches'][number];
type IconName = Parameters<typeof Icon>[0]['name'];
type Menu = 'project' | 'location' | 'branch';
export type WorktreeSelection = { path: string; baseRef: string | null; includeChanges: boolean };
type RecentProject = { path: string; name: string; id: string | null };

export async function readProjectLocation(host: Host, path: string) {
  const result: WorktreeResult = await host
    .query('agent', 'projectWorktrees', { path })
    .catch(() => ({ kind: 'unavailable' as const }));
  return { path: result.kind === 'git' ? result.root : path, result };
}

const refOf = (branch: Branch) => `refs/${branch.remote ? 'remotes' : 'heads'}/${branch.name}`;
const addProject = 'add-project';
const newWorktree = 'new-worktree';
const localFiles = 'local-files';
const localCheckout = 'local';
const retry = 'retry';
const actions = 'actions';
const branchPrefix = 'maka-';
const branchErrors = {
  invalid_branch: 'Enter a valid Git branch name.',
  branch_unavailable: 'This branch is no longer available.',
  already_exists: 'This branch already exists. Choose another name.',
  checked_out_elsewhere: 'This branch is already checked out in another worktree.',
  overwrites_changes:
    'Switching branches would overwrite local changes. Commit or stash them first.',
  workspace_busy: 'This folder is in use. Try again when the current operation finishes.',
  git_required: 'Install Git to switch or create branches.',
  unsupported: 'This Git configuration does not support switching branches here.',
  unavailable: 'Could not check out the branch.',
} as const satisfies Record<
  Extract<BranchCheckout['output'], { kind: 'failed' }>['reason'],
  MessageKey
>;

const chipStyle = {
  maxWidth: 244,
  minWidth: 0,
  flexShrink: 1,
  flexDirection: 'row',
  alignItems: 'center',
  height: 28,
  gap: 6,
  paddingHorizontal: 8,
  borderRadius: 8,
} as const;
const chipTextStyle = () => [
  { ...captionTextStyle, color: C.text, minWidth: 0, flexShrink: 1 },
  { numberOfLines: 1 },
];
const menuAnchor = { placement: 'top', align: 'start', offset: 4, margin: 8 } as const;
const branchMenuHeight = 344;

type Choice = {
  value: string;
  title: string;
  text?: string;
  detail?: string;
  icon: IconName;
  group?: string;
  disabled?: boolean;
};

function ChoiceRow(props: { choice: Choice; selected?: boolean }) {
  return (
    <View style={{ ...menuRowStyle(), paddingVertical: 4 }}>
      <Icon name={props.choice.icon} size={14} color={C.secondary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={[
            { ...captionTextStyle, color: C.text },
            { numberOfLines: 1, textOverflow: 'ellipsis-middle' },
          ]}
        >
          {props.choice.text ?? props.choice.title}
        </Text>
        <If when={props.choice.detail}>
          <Text
            style={[
              { ...menuDetailTextStyle, color: C.muted },
              { numberOfLines: 1, textOverflow: 'ellipsis-middle' },
            ]}
          >
            {props.choice.detail}
          </Text>
        </If>
      </View>
      <View style={{ width: 16 }}>
        <If when={props.selected}>
          <Icon name="check" size={14} color={C.accent} />
        </If>
      </View>
    </View>
  );
}

type WorkspaceMenuProps = {
  label: string;
  labelText: string;
  description?: string;
  icon: IconName;
  width: number;
  choices: Choice[];
  value: string | null;
  search?: string;
  empty?: string;
  emphasized?: boolean;
  open: boolean;
  disabled: boolean;
  onOpenChange(open: boolean): void;
  choose(value: string): void;
};

function WorkspaceSelect(props: WorkspaceMenuProps) {
  return (
    <Select
      accessibilityLabel={props.label}
      {...menuAnchor}
      cover={false}
      style={{ flexShrink: 1, minWidth: 0 }}
      popupStyle={{
        ...floatingStyle(),
        width: props.width,
        maxHeight: Math.min(260, Math.floor(windowSize().height * 0.35)),
      }}
      open={props.open}
      disabled={props.disabled}
      value={props.value}
      items={props.choices}
      searchable={!!props.search}
      searchAccessibilityLabel={props.search}
      searchPlaceholder={props.search}
      searchStyle={{
        ...captionTextStyle,
        height: 32,
        marginHorizontal: 4,
        paddingHorizontal: 8,
        color: C.text,
        placeholderColor: C.muted,
        backgroundColor: C.surface,
        borderRadius: 8,
      }}
      empty={<Text style={menuLabelStyle()}>{props.empty ?? tr('No matches.')}</Text>}
      onOpenChange={({ open }) => props.onOpenChange(open)}
      onChange={({ value }) => {
        if (value !== null) props.choose(value);
      }}
      trigger={
        <View
          tooltip={props.description ? textTooltip(() => props.description!) : undefined}
          style={{
            ...chipStyle,
            backgroundColor: props.open || props.emphasized ? C.cardRaised : undefined,
          }}
          hoverStyle={{ backgroundColor: C.cardRaised }}
          focusStyle={quietFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name={props.icon} size={14} color={C.secondary} />
          <Text style={chipTextStyle()}>{props.labelText}</Text>
          <Icon name="down" size={10} color={C.muted} />
        </View>
      }
      itemStyle={{ padding: 0 }}
      itemClass={`rounded-lg focus:bg-[${C.floatingRaised}]`}
      renderGroup={(group) =>
        group.title === actions ? (
          <View style={menuSeparatorStyle()} />
        ) : (
          <Text style={menuLabelStyle()}>{group.title}</Text>
        )
      }
      renderItem={(item) => (
        <ChoiceRow
          choice={
            props.choices[item.index] ?? { value: item.value, title: item.title, icon: props.icon }
          }
          selected={item.value === props.value}
        />
      )}
    />
  );
}

function BranchMenu(props: WorkspaceMenuProps & { footer?: JSX.Element }) {
  const choices = computed(() => new Map(props.choices.map((choice) => [choice.value, choice])));
  const popupHeight = () => Math.min(branchMenuHeight, Math.floor(windowSize().height * 0.4));
  return (
    <Popover
      open={props.open}
      onOpenChange={({ open }) => props.onOpenChange(open)}
      {...menuAnchor}
      style={{ flexShrink: 1, minWidth: 0 }}
      popupStyle={{
        ...floatingStyle(),
        width: props.width,
        maxHeight: popupHeight(),
      }}
      trigger={
        <Button
          accessibilityLabel={props.label}
          disabled={props.disabled}
          style={{ flexShrink: 1, minWidth: 0, padding: 0, borderWidth: 0, borderRadius: 8 }}
          focusStyle={quietFocusStyle()}
          hoverStyle={{ backgroundColor: C.cardRaised }}
          disabledStyle={controlDisabledStyle}
        >
          <View
            tooltip={props.description ? textTooltip(() => props.description!) : undefined}
            style={{
              ...chipStyle,
              backgroundColor: props.open || props.emphasized ? C.cardRaised : undefined,
            }}
          >
            <Icon name={props.icon} size={14} color={C.secondary} />
            <Text style={chipTextStyle()}>{props.labelText}</Text>
            <Icon name="down" size={10} color={C.muted} />
          </View>
        </Button>
      }
    >
      <Command
        style={{ maxHeight: popupHeight() - 10, minHeight: 0, flexShrink: 1 }}
        items={props.choices.map((choice) => ({
          id: choice.value,
          label: choice.title,
          group: choice.group,
          checked: choice.value === props.value,
          disabled: choice.disabled,
        }))}
        accessibilityLabel={props.label}
        searchable={!!props.search}
        searchAccessibilityLabel={props.search}
        placeholder={props.search}
        searchPrefix={<Icon name="search" size={14} color={C.muted} />}
        searchBarStyle={{
          paddingHorizontal: 8,
          height: 32,
          flexShrink: 0,
          gap: 8,
          flexDirection: 'row',
          alignItems: 'center',
        }}
        searchStyle={{ ...captionTextStyle, flex: 1, color: C.text, placeholderColor: C.muted }}
        autoFocus
        separator={false}
        onCancel={() => props.onOpenChange(false)}
        onSelect={({ id }) => {
          props.onOpenChange(false);
          props.choose(id);
        }}
        empty={<Text style={menuLabelStyle()}>{props.empty ?? tr('No matches.')}</Text>}
        itemStyle={{ padding: 0 }}
        itemClass={`rounded-lg focus:bg-[${C.floatingRaised}]`}
        renderGroup={(group) => (
          <Text style={{ ...menuLabelStyle(), paddingTop: 4 }}>{group.heading}</Text>
        )}
        renderItem={(entry) => (
          <ChoiceRow
            choice={
              choices().get(entry.id) ?? { value: entry.id, title: entry.label, icon: props.icon }
            }
            selected={entry.checked}
          />
        )}
        footer={props.footer}
      />
    </Popover>
  );
}

export function SessionWorkspaces(props: {
  host: Host;
  path(): string;
  projects(): readonly BrowserProject[];
  projectError(): string;
  recent(): readonly RecentWorkspace[];
  blocked(): boolean;
  worktreeSelection(): WorktreeSelection | null;
  retryingWorktree(): boolean;
  selectWorktree(selection: WorktreeSelection | null): void;
  selectionPending(pending: boolean): void;
  choose(path: string): Promise<void>;
  checkout(input: BranchCheckout['input']): Promise<BranchCheckout['output']>;
  focusComposer(): void;
  browse(): void;
  refreshProjects(): void;
  report(reason: unknown): void;
}) {
  const observed = signal<{ path: string; result: WorktreeResult } | null>(null);
  const info = computed(() => {
    const current = observed();
    return current?.path === props.path() ? current.result : null;
  });
  const choosing = signal(false);
  const openMenu = signal<Menu | null>(null);
  const branchDraft = signal<string | null>(null);
  const branchError = createText();
  let branchInput: InputRef | undefined;
  const recentProjects = signal<ReadonlyMap<string, RecentProject>>(new Map());
  let preloaded: { path: string; result: WorktreeResult } | null = null;
  let read = 0;
  let projectRead = 0;
  let alive = true;
  cleanup(() => {
    alive = false;
    props.selectionPending(false);
  });
  effect(() => props.selectionPending(choosing() || branchDraft() !== null));
  const load = async (path: string) => {
    const request = ++read;
    if (!path) return;
    const { result } = await readProjectLocation(props.host, path);
    if (alive && path === props.path() && request === read) observed.set({ path, result });
  };
  effect(() => {
    const path = props.path();
    openMenu.set(null);
    branchDraft.set(null);
    const initial = preloaded?.path === path ? preloaded.result : null;
    preloaded = null;
    if (initial) {
      read += 1;
      observed.set({ path, result: initial });
      return;
    }
    observed.set(null);
    void load(path);
  });
  const git = computed(() => {
    const result = info();
    return result?.kind === 'git' ? result : null;
  });
  const worktreeName = computed(() => {
    const repository = git();
    const path = props.path();
    return repository && path !== repository.root ? basenameLabel(path) : null;
  });
  const projectPath = () => git()?.root ?? props.path();
  const loadRecentProjects = async () => {
    const request = ++projectRead;
    const catalogPaths = new Set(props.projects().map((project) => project.path));
    const requested = new Set([props.path(), ...props.recent().map(({ path }) => path)]);
    const paths = [...requested].filter((path) => path && !catalogPaths.has(path));
    const resolved = await Promise.allSettled(
      paths.map(async (path): Promise<RecentProject | null> => {
        const result = await props.host.query('agent', 'projects', { kind: 'directory', path });
        if (result.kind !== 'directory') return null;
        const { location } = result;
        if (location.project) {
          const project = location.project;
          return project.available && !project.archived && project.path
            ? { path: project.path, name: project.name, id: project.reference.id }
            : null;
        }
        const checkout = await readProjectLocation(props.host, location.path);
        return {
          path: checkout.path,
          name: location.name,
          id: null,
        };
      }),
    );
    if (!alive || request !== projectRead) return;
    const next = new Map<string, RecentProject>();
    for (const [index, result] of resolved.entries()) {
      if (result.status === 'fulfilled' && result.value) next.set(paths[index]!, result.value);
    }
    recentProjects.set(next);
  };
  const projectItems = computed(() => {
    const repository = git();
    const worktreePaths = new Set(repository?.worktrees.map((item) => item.path));
    const active = props.path();
    const path = projectPath();
    const projects = props.projects();
    const catalogIds = new Set(projects.map((project) => project.reference.id));
    const activeId =
      projects.find((project) => project.path === active)?.reference.id ??
      recentProjects().get(active)?.id;
    const items = new Map<string, string>();
    for (const { path: recent } of props.recent()) {
      const folder = recentProjects().get(recent);
      if (folder && (!folder.id || !catalogIds.has(folder.id))) items.set(folder.path, folder.name);
    }
    for (const project of projects) {
      if (!project.archived && project.available && project.path)
        items.set(
          project.reference.id === activeId || worktreePaths.has(project.path)
            ? path
            : project.path,
          project.name,
        );
    }
    if (path && !items.has(path)) items.set(path, basenameLabel(path));
    return items;
  });
  const projectName = () => projectItems().get(projectPath()) ?? tr('Project');
  const projectChoices = computed((): Choice[] => {
    const names = new Map<string, number>();
    for (const name of projectItems().values()) names.set(name, (names.get(name) ?? 0) + 1);
    const items: Choice[] = [...projectItems()].map(([path, name]) => ({
      value: path,
      title: name !== basenameLabel(path) ? name : tr('Use folder {path}', { path }),
      text: name,
      detail: (names.get(name) ?? 0) > 1 ? path : undefined,
      icon: 'folder',
    }));
    if (props.projectError())
      items.push({ value: retry, title: tr('Could not load projects. Retry'), icon: 'refresh' });
    items.push({
      value: addProject,
      title: tr('Choose another folder…'),
      text: tr('Add project folder…'),
      icon: 'plus',
      group: actions,
    });
    return items;
  });
  const headBranch = () => git()?.headBranch ?? tr('Detached HEAD');
  const currentRef = () => {
    const head = git()?.headBranch;
    return head ? `refs/heads/${head}` : null;
  };
  const branchTooltip = () => {
    const branch = headBranch();
    const count = git()?.uncommittedFiles;
    return count
      ? `${branch}\n${tr('Uncommitted files · {count}', { count: formatCount(count) })}`
      : branch;
  };
  const blocked = () => props.blocked() || choosing();
  const baseBranch = () => {
    const selection = props.worktreeSelection();
    const branch = selection?.baseRef?.replace(/^refs\/(?:heads|remotes)\//, '');
    return branch && selection?.includeChanges
      ? tr('{branch} + local changes', { branch })
      : branch;
  };
  const toggle = (menu: Menu, open: boolean) => {
    if (!alive) return;
    if (open) {
      if (blocked()) return;
      openMenu.set(menu);
      if (menu === 'project') void loadRecentProjects();
      else void load(props.path());
    } else if (openMenu() === menu) openMenu.set(null);
  };
  const selectProject = async (path: string) => {
    if (blocked()) return;
    if (path === addProject) {
      openMenu.set(null);
      return props.browse();
    }
    if (path === retry) return props.refreshProjects();
    if (path === projectPath() || !projectItems().has(path)) return;
    const previous = props.path();
    choosing.set(true);
    try {
      const { path: target, result } = await readProjectLocation(props.host, path);
      if (!alive || props.path() !== previous || props.blocked()) return;
      // The first read can serve the selected checkout when it describes that path.
      if (target === path && target !== previous) preloaded = { path, result };
      await props.choose(target);
    } catch (reason) {
      if (alive) props.report(reason);
    } finally {
      if (preloaded && preloaded.path !== props.path()) preloaded = null;
      if (alive) choosing.set(false);
    }
  };
  const startWorktree = () => {
    const repository = git();
    if (!repository?.branches.length || props.worktreeSelection()) return;
    const head = repository.branches.find(
      (item) => !item.remote && item.name === repository.headBranch,
    );
    props.selectWorktree({
      path: props.path(),
      baseRef: head ? refOf(head) : repository.defaultBase,
      includeChanges: false,
    });
  };
  const selectLocation = async (value: string) => {
    if (blocked()) return;
    if (value === newWorktree) return startWorktree();
    if (value !== localCheckout) return;
    const target = git()?.root;
    if (!target) return;
    if (target === props.path()) {
      props.selectWorktree(null);
      return;
    }
    choosing.set(true);
    try {
      await props.choose(target);
    } catch (reason) {
      if (alive) props.report(reason);
    } finally {
      if (alive) choosing.set(false);
    }
  };
  const locationChoices = (): Choice[] => {
    const repository = git();
    if (!repository) return [];
    return [
      { value: localCheckout, title: tr('Local'), icon: 'laptop', group: tr('Work location') },
      {
        value: newWorktree,
        title: tr('New local worktree'),
        icon: 'fork',
        group: tr('Work location'),
        disabled: repository.branches.length === 0,
        detail:
          repository.branches.length === 0
            ? tr('Commit to a branch before creating a worktree.')
            : undefined,
      },
    ];
  };
  const branchChoices = computed((): Choice[] => {
    const repository = git();
    if (!repository) return [];
    const pending = props.worktreeSelection();
    const head = currentRef();
    const count = repository.uncommittedFiles;
    const row = (branch: Branch, group: string): Choice => ({
      value: refOf(branch),
      title: branch.name,
      icon: 'gitBranch',
      group,
      detail:
        !pending && refOf(branch) === head && count
          ? tr('Uncommitted files · {count}', { count: formatCount(count) })
          : undefined,
    });
    const local = repository.branches.filter((branch) => !branch.remote);
    local.sort((a, b) => Number(refOf(b) === head) - Number(refOf(a) === head));
    if (!pending) return local.map((branch) => row(branch, tr('Branches')));
    const remote = repository.branches.filter((branch) => branch.remote);
    const starting = remote.find(
      (branch) =>
        refOf(branch) ===
        (repository.defaultBase ?? `refs/remotes/origin/${repository.headBranch}`),
    );
    const items: Choice[] = [];
    if (head && count) {
      items.push({
        value: localFiles,
        title: `${headBranch()} · ${tr('Includes local changes')}`,
        text: headBranch(),
        detail: tr('Includes local changes'),
        icon: 'gitBranch',
        group: tr('Starting points'),
      });
    }
    if (starting) items.push(row(starting, tr('Starting points')));
    return [
      ...items,
      ...local.map((branch) => row(branch, tr('Local branches'))),
      ...remote
        .filter((branch) => branch !== starting)
        .map((branch) => row(branch, tr('Remote branches'))),
    ];
  });
  const checkout = async (branch: string, create: boolean) => {
    const path = props.path();
    if (blocked() || git()?.root !== path || props.worktreeSelection()) return;
    choosing.set(true);
    branchError.set('');
    try {
      const result = await props.checkout({ path, branch, create });
      if (!alive || props.path() !== path) return;
      if (result.kind === 'failed') throw new UiError(branchErrors[result.reason]);
      branchDraft.set(null);
    } catch (reason) {
      if (!alive || props.path() !== path) return;
      if (create) branchError.set(errorText(reason, 'Could not check out the branch.'));
      else props.report(reason);
    } finally {
      if (alive && props.path() === path) await load(path);
      if (alive) {
        choosing.set(false);
        if (props.path() === path && branchDraft() === null) props.focusComposer();
      }
    }
  };
  const chooseBranch = (value: string) => {
    const selection = props.worktreeSelection();
    if (blocked()) return;
    if (selection) {
      if (props.retryingWorktree()) return;
      const includeChanges = value === localFiles;
      props.selectWorktree({
        ...selection,
        baseRef: includeChanges ? currentRef() : value,
        includeChanges,
      });
    } else if (value !== currentRef()) {
      void checkout(value.slice('refs/heads/'.length), false);
    }
  };
  const draftName = () => branchDraft()?.trim() ?? '';
  const canCreateBranch = () => !blocked() && !!draftName() && draftName() !== branchPrefix;
  const createBranch = () => {
    if (canCreateBranch()) void checkout(draftName(), true);
  };
  const closeBranchDialog = () => {
    if (choosing()) return;
    branchDraft.set(null);
    props.focusComposer();
  };
  const openBranchDialog = () => {
    if (blocked()) return;
    openMenu.set(null);
    branchError.set('');
    branchDraft.set(branchPrefix);
  };
  return (
    <View
      style={{
        alignSelf: 'stretch',
        marginHorizontal: 8,
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 4,
        backgroundColor: C.card,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        flexShrink: 0,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <WorkspaceSelect
        label={tr('Choose composer workspace')}
        labelText={projectName()}
        description={projectPath()}
        icon="folder"
        width={286}
        value={projectPath() || null}
        search={tr('Search projects…')}
        choices={projectChoices()}
        open={openMenu() === 'project'}
        onOpenChange={(open) => toggle('project', open)}
        disabled={blocked()}
        choose={(value) => void selectProject(value)}
      />
      <If when={git() !== null}>
        <WorkspaceSelect
          label={tr('Work location')}
          labelText={
            props.worktreeSelection() ? tr('New local worktree') : (worktreeName() ?? tr('Local'))
          }
          description={props.worktreeSelection() ? undefined : props.path()}
          icon={props.worktreeSelection() || worktreeName() ? 'fork' : 'laptop'}
          emphasized={props.worktreeSelection() !== null}
          width={208}
          value={props.worktreeSelection() ? newWorktree : worktreeName() ? null : localCheckout}
          choices={locationChoices()}
          open={openMenu() === 'location'}
          onOpenChange={(open) => toggle('location', open)}
          disabled={blocked()}
          choose={(value) => void selectLocation(value)}
        />
      </If>
      <If when={info()?.kind === 'unavailable'}>
        <Button
          accessibilityLabel={tr('Could not read work locations. Retry')}
          onPress={() => void load(props.path())}
          disabled={blocked()}
          style={{ ...chipStyle, paddingVertical: 0, borderWidth: 0 }}
          hoverStyle={{ backgroundColor: C.cardRaised }}
          focusStyle={quietFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="refresh" size={14} color={C.secondary} />
          <Text style={chipTextStyle()}>{tr('Could not read work locations. Retry')}</Text>
        </Button>
      </If>
      <If
        when={
          git() !== null && (props.worktreeSelection() !== null || git()?.root === props.path())
        }
      >
        <BranchMenu
          label={tr(props.worktreeSelection() ? 'Base branch' : 'Switch branch')}
          labelText={
            props.worktreeSelection() ? (baseBranch() ?? tr('Select base branch')) : headBranch()
          }
          description={props.worktreeSelection() ? baseBranch() : branchTooltip()}
          icon="gitBranch"
          width={320}
          search={tr('Search branches…')}
          empty={tr('No matching branches')}
          value={
            props.worktreeSelection()
              ? props.worktreeSelection()?.includeChanges
                ? localFiles
                : (props.worktreeSelection()?.baseRef ?? null)
              : currentRef()
          }
          choices={branchChoices()}
          open={openMenu() === 'branch'}
          onOpenChange={(open) => toggle('branch', open)}
          disabled={blocked() || props.retryingWorktree()}
          choose={chooseBranch}
          footer={
            props.worktreeSelection() ? undefined : (
              <View style={{ flexShrink: 0 }}>
                <View style={menuSeparatorStyle()} />
                <Button
                  accessibilityLabel={tr('Create and check out new branch…')}
                  onPress={openBranchDialog}
                  style={{ borderWidth: 0, padding: 0, borderRadius: 8 }}
                  hoverStyle={menuRowHoverStyle()}
                  focusStyle={quietFocusStyle()}
                >
                  <ChoiceRow
                    choice={{
                      value: '',
                      title: tr('Create and check out new branch…'),
                      icon: 'plus',
                    }}
                  />
                </Button>
              </View>
            )
          }
        />
      </If>
      <If when={git() !== null && git()?.root !== props.path() && !props.worktreeSelection()}>
        <View style={chipStyle} tooltip={textTooltip(branchTooltip)}>
          <Icon name="gitBranch" size={14} color={C.secondary} />
          <Text accessibilityLabel={branchTooltip()} style={chipTextStyle()}>
            {headBranch()}
          </Text>
        </View>
      </If>
      <If when={branchDraft() !== null}>
        <ModalDialog
          size="alert"
          onOpen={() => {
            branchInput?.focus();
            branchInput?.setSelection(branchPrefix.length, branchPrefix.length);
          }}
          onCancel={closeBranchDialog}
        >
          <DialogHeader title={tr('Create and check out branch')} />
          <View style={{ gap: 6 }}>
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Branch name')}</Text>
            <Input
              ref={(node) => {
                branchInput = node;
              }}
              accessibilityLabel={tr('Branch name')}
              value={branchDraft() ?? ''}
              readonly={choosing()}
              onChange={({ value }) => {
                branchDraft.set(value);
                branchError.set('');
              }}
              onSubmit={createBranch}
              style={{
                height: 34,
                ...inputTextStyle,
                color: C.text,
                backgroundColor: C.background,
                borderWidth: 1,
                borderColor: C.line,
                borderRadius: inputBorderRadius,
                paddingHorizontal: 10,
              }}
              focusStyle={{ borderColor: C.accent }}
            />
            <If when={branchError()}>
              <Text style={{ ...captionTextStyle, color: C.danger }}>{branchError()}</Text>
            </If>
          </View>
          <DialogFooter>
            <SettingsButton
              label={tr('Cancel')}
              onPress={closeBranchDialog}
              disabled={choosing()}
            />
            <SettingsButton
              label={tr('Create and check out')}
              tone="primary"
              disabled={!canCreateBranch()}
              onPress={createBranch}
            />
          </DialogFooter>
        </ModalDialog>
      </If>
    </View>
  );
}

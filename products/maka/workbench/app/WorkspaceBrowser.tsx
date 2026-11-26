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

import { LoadingIndicator } from './Loading';
import { SidebarTitleRow, textTooltip } from './ui';
import { InlineCallout, RegionEmptyError } from './Feedback';
import { message, renderText } from './text';
import { toast } from './toastStore';
import { tr } from './locale';
import {
  batch,
  cleanup,
  computed,
  effect,
  inputAction,
  signal,
  Text,
  untracked,
  View,
  Image,
  List,
  platform,
} from 'nsh';
import type { JSX, ListRef, Signal, ViewRef } from 'nsh';
import { Button, ContextMenu, Menu, Popover, Switch } from 'nsh/base';
import logo from './assets/maka.png';
import { keymap } from 'nsh';
import {
  C,
  compact,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  floatingStyle,
} from './ui';
import { Icon } from './Icon';
import type { Browsing, BrowserProject, BrowserScope, BrowserWorkspace } from './browsing';
import { SessionActions } from './SessionActions';
import { SessionMenuItems, type SessionMenuAction } from './SessionMenu';
import { Automations } from './Automations';
import {
  groupWorkspace,
  groupConversations,
  groupConversationsByTime,
  foldableFamilies,
  projectSessionLimit,
  topLevelCount,
  withinLimit,
  unfoldedSessions,
  type ConversationGroup,
} from './conversationGroups';
import { sidebarPreferences, type SidebarFeature } from './sidebarPreferences';
import { workspaceSessions } from './sessionNesting';
import type { AgentSession } from '../../../../packages/plugin-sdk/src/index.js';
import {
  hasForkPrefix,
  sessionActionTarget,
  type SessionAction,
  type SessionActionTarget,
} from './sessionLifecycle';
import { sessionStatusCaption } from './sessionStatus';
import { ownTitleBar, TITLE_BAR_HEIGHT, windowDrag } from './chrome';
import { SidebarUpdateButton } from './SidebarUpdateButton';

export type WorkspaceBrowserProps = {
  openRooms?: (() => void) | undefined;
  navigationMore?: (() => JSX.Element) | undefined;
  pinSidebar?: (() => void) | undefined;
  suppressSidebarHover?: (() => void) | undefined;
  holdSidebarHover?: ((active: boolean) => void) | undefined;
  docked(): boolean;
  connectionLost(): boolean;
  browsing: Browsing;
  selected(): string | null;
  switching(): boolean;
  focusRequest(): boolean;
  focusHandled(): void;
  attach(node: ViewRef): void;
  close(): void;
  /** Collapses the docked browser, from the toggle in its top row. */
  collapse(expectedSessionId: string | null): void;
  /** Resolves whether it opened; a side question opens as its card beside its conversation. */
  selectSession(id: string, expectedSessionId: string | null): Promise<boolean>;
  create(
    workspace: BrowserWorkspace,
    expectedSessionId: string | null,
    label?: string,
  ): Promise<void>;
  newConversation(expectedSessionId: string | null): void;
  /** Open the persistent Bot; absent when the Bot mode is not offered. */
  openBot?(expectedSessionId: string | null): void;
  /** The Bot Session, listed only through its own entry. */
  botSession?(): string | null | undefined;
  /** The conversations the Bot created; the running and waiting ones show under its entry. */
  botWorkers?(): readonly AgentSession[];
  settings(expectedSessionId: string | null): void;
  search(expectedSessionId: string | null): void;
  changeSession(action: SessionAction, expectedSessionId: string | null): Promise<void>;
  /** Whether a conversation can open in a pane beside the current one. */
  canOpenBeside?(): boolean;
  /** The conversations open beside the selected one, marked like a selected row. */
  beside?(): readonly string[];
  openBeside?(sessionId: string): void;
  /**
   * The keys of the collapsed workspace groups, kept by the owner, whose
   * next and previous conversation skip them.
   */
  collapsedGroups?: Signal<ReadonlySet<string>>;
  expandedProjects?: Signal<ReadonlySet<string>>;
  /** The conversations whose created ones are folded behind one row, kept by the owner. */
  foldedFamilies?: Signal<ReadonlySet<string>>;
};

type WorkspaceGroup = ConversationGroup<BrowserProject> & { name: string };

// Nested rows' guide line, a little inside the parent's title.
const guideInset = 10;
const nestInset = 16;
// The line runs on past a row, or bends into the last one of its family.
function GuideLine(props: { last(): boolean; height(): number }) {
  return (
    <View
      style={[
        props.last()
          ? {
              position: 'absolute',
              left: guideInset,
              top: 0,
              width: nestInset - guideInset,
              height: props.height() / 2,
              borderLeftWidth: 1,
              borderBottomWidth: 1,
              borderBottomLeftRadius: 6,
              borderColor: C.muted,
            }
          : {
              position: 'absolute',
              left: guideInset,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: C.muted,
            },
        // The row separator's color is lost on the sidebar; quieter text is not.
        { opacity: 0.45, pointerEvents: 'none' },
      ]}
    />
  );
}
// At most this many of the Bot's running or waiting conversations show under it.
const botWorkerCap = 5;

/** What a branch is, for its row. Forks renamed or titled before the prefix still read as forks. */
function branchCaption(session: AgentSession): string {
  if (session.branch?.side) return tr('Side question');
  return session.branch && !hasForkPrefix(session.title) ? tr('Fork') : '';
}

export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const titleBarRow = () => ownTitleBar && (props.docked() || !!props.pinSidebar);
  const navIcon = () => (platform.idiom === 'terminal' ? C.secondary : C.muted);
  const navText = () => (platform.idiom === 'terminal' ? C.text : C.secondary);
  const selectedNavText = (selected: boolean) => ({
    fontSize: 14,
    color: selected && platform.idiom !== 'terminal' ? C.text : navText(),
    fontWeight: selected && platform.idiom !== 'terminal' ? ('500' as const) : undefined,
  });
  const botSelected = () =>
    props.botSession?.() != null && props.selected() === props.botSession?.();
  // Desktop rows hold one line; the terminal's also name the workspace.
  const rowHeight = () => (compact() ? 32 : platform.idiom === 'terminal' ? 48 : 36);
  const navigationRowHeight = () => (platform.idiom === 'terminal' && !compact() ? 40 : 32);
  const browser = props.browsing;
  const visibleSessions = computed(() => {
    const bot = props.botSession?.() ?? null;
    const sessions = browser.sessions();
    return workspaceSessions(sessions, bot, browser.filter(), platform.idiom !== 'terminal');
  });
  // Running and waiting first-hand work of the Bot, waiting first; the open
  // one stays while it is open. The rest are on the Bot's page.
  const activeBotWorkers = computed(() => {
    if (platform.idiom === 'terminal') return [];
    const selected = props.selected();
    return (props.botWorkers?.() ?? [])
      .filter(
        (session) => !session.archived && (session.activity !== 'idle' || session.id === selected),
      )
      .sort(
        (a, b) =>
          Number(b.activity === 'waiting') - Number(a.activity === 'waiting') ||
          b.updatedAt - a.updatedAt,
      );
  });
  const shownBotWorkers = () => activeBotWorkers().slice(0, botWorkerCap);
  const moreBotWorkers = () => Math.max(0, activeBotWorkers().length - botWorkerCap);
  const choosingWorkspace = signal(false);
  const automationsOpen = signal(false);
  const moreFeaturesOpen = signal(false);
  let holdingHover = false;
  const setMoreFeaturesOpen = (open: boolean) => {
    moreFeaturesOpen.set(open);
    if (holdingHover !== open) {
      holdingHover = open;
      props.holdSidebarHover?.(open);
    }
  };
  const sortByTime = () =>
    platform.idiom !== 'terminal' &&
    browser.filter() === 'all' &&
    sidebarPreferences.sortMode() === 'time';
  const actions = signal<{
    session: SessionActionTarget;
    origin: string | null;
    action: SessionMenuAction;
  } | null>(null);

  const viewportHeight = signal(160);
  let navigationTarget: ViewRef | undefined;
  let list: ListRef | undefined;
  let removeEscape = () => {};
  let alive = true;
  cleanup(() => {
    alive = false;
    removeEscape();
    if (holdingHover) {
      holdingHover = false;
      props.holdSidebarHover?.(false);
    }
  });
  const scopeLabel = () => {
    const scope = browser.scope();
    if (scope.kind === 'all') return tr('All workspaces');
    if (scope.kind === 'project')
      return (
        browser.projects().find((project) => project.reference.id === scope.projectId)?.name ??
        tr('Project')
      );
    return (
      visibleSessions()[0]?.workspace.path.split('/').filter(Boolean).at(-1) ?? tr('Workspace')
    );
  };
  const scopes = computed(() => [
    { id: 'all', title: tr('All workspaces'), detail: '', scope: { kind: 'all' } as BrowserScope },
    ...(props.selected()
      ? [
          {
            id: 'workspace',
            title: tr('Current workspace'),
            detail: '',
            scope: { kind: 'workspace', sessionId: props.selected()! } as BrowserScope,
          },
        ]
      : []),
    ...browser
      .projects()
      .filter((project) => !project.archived)
      .map((project) => ({
        id: project.reference.id,
        title: project.name,
        detail: project.path ?? tr('Unavailable'),
        scope: { kind: 'project', projectId: project.reference.id } as BrowserScope,
      })),
  ]);
  const sessionsById = computed(
    () => new Map(visibleSessions().map((session) => [session.id, session])),
  );
  const scopesById = computed(() => new Map(scopes().map((scope) => [scope.id, scope])));
  const firstUnpinned = computed(() => visibleSessions().find((session) => !session.pinned)?.id);
  const hasPinned = () => visibleSessions()[0]?.pinned === true;
  const collapsed = props.collapsedGroups ?? signal<ReadonlySet<string>>(new Set());
  const expanded = props.expandedProjects ?? signal<ReadonlySet<string>>(new Set());
  const projectsById = computed(
    () => new Map(browser.projects().map((project) => [project.reference.id, project])),
  );
  const groups = computed(() => {
    const raw = sortByTime()
      ? groupConversationsByTime<BrowserProject>(visibleSessions())
      : groupConversations(visibleSessions(), browser.projects(), browser.filter() === 'all');
    return raw.map((group): WorkspaceGroup => {
      const name = group.pinned
        ? tr('Pinned')
        : group.key === 'time:today'
          ? tr('Today')
          : group.key === 'time:yesterday'
            ? tr('Yesterday')
            : group.key === 'time:earlier'
              ? tr('Earlier')
              : (group.project?.name ??
                (group.path!.split('/').filter(Boolean).at(-1) || group.path!));
      return { ...group, name };
    });
  });
  const nestedRows = computed(() => new Set(groups().flatMap((group) => [...group.nested])));
  // A nested row's guide line ends at the last of its family.
  const lastNestedRows = computed(() => {
    const nested = nestedRows();
    const last = new Set<string>();
    for (const group of groups())
      group.sessions.forEach((id, index) => {
        if (nested.has(id) && !nested.has(group.sessions[index + 1] ?? '')) last.add(id);
      });
    return last;
  });
  const groupsById = computed(() => new Map(groups().map((group) => [group.key, group])));
  const foldedFamilies = props.foldedFamilies ?? signal<ReadonlySet<string>>(new Set());
  // Only the full project-grouped list folds created families.
  const families = computed(() =>
    browser.filter() === 'all' && !sortByTime()
      ? new Map(groups().flatMap((group) => [...foldableFamilies(group)]))
      : new Map<string, string[]>(),
  );
  const familyOf = computed(() => {
    const parents = new Map<string, string>();
    for (const [parent, members] of families()) for (const id of members) parents.set(id, parent);
    return parents;
  });
  const shownSessions = (group: WorkspaceGroup) =>
    browser.filter() === 'all' ? unfoldedSessions(group, foldedFamilies()) : group.sessions;
  const toggleFamily = (parent: string) => {
    const next = new Set(foldedFamilies());
    if (!next.delete(parent)) next.add(parent);
    foldedFamilies.set(next);
  };
  // Opening a folded conversation, from search or a notice, unfolds its
  // family once; folding it again afterwards is the user's call.
  let unfoldedFor: string | null = null;
  effect(() => {
    const id = props.selected();
    const parent = id ? familyOf().get(id) : undefined;
    if (!id || !parent || id === unfoldedFor) return;
    unfoldedFor = id;
    untracked(() => {
      if (!foldedFamilies().has(parent)) return;
      const next = new Set(foldedFamilies());
      next.delete(parent);
      foldedFamilies.set(next);
    });
  });
  const rowIds = computed(() =>
    platform.idiom === 'terminal'
      ? choosingWorkspace()
        ? scopes().map((scope) => scope.id)
        : visibleSessions().map((session) => session.id)
      : groups().flatMap((group) => {
          const heading = `group:${group.key}`;
          if (collapsed().has(group.key)) return [heading];
          const all = shownSessions(group);
          const limit = projectSessionLimit(group);
          const more = topLevelCount(group) > limit;
          const sessions =
            !more || expanded().has(group.key) ? all : withinLimit(group, all, limit);
          // A folding family's row sits right under its creator, open or not.
          const rows = sessions.flatMap((id) => (families().has(id) ? [id, `family:${id}`] : [id]));
          return [heading, ...rows, ...(more ? [`show-more:${group.key}`] : [])];
        }),
  );
  const toggleGroup = (key: string) => {
    const next = new Set(collapsed());
    if (!next.delete(key)) next.add(key);
    collapsed.set(next);
  };
  const toggleProjectSessions = (key: string) => {
    const next = new Set(expanded());
    if (!next.delete(key)) next.add(key);
    expanded.set(next);
  };
  const select = async ({ id, origin }: { id: string; origin: string | null }) => {
    if (!alive || props.selected() !== origin || props.switching()) return;
    const opened = await props.selectSession(id, origin);
    // In Desktop docked mode the conversation stays visible and reports draft blocks directly.
    if (alive && !opened && id !== origin && props.selected() === origin && !props.docked()) {
      toast.show({
        id: 'workbench.draft-not-ready',
        tone: 'warning',
        message: renderText(
          message(
            'The draft is not ready to save. Return to the conversation to check its status.',
          ),
        ),
        actions: [{ label: tr('Return to draft'), primary: true, onPress: props.close }],
      });
    }
  };
  const openActions = (target: {
    session: SessionActionTarget;
    origin: string | null;
    action: SessionMenuAction;
  }) => {
    if (
      alive &&
      !props.switching() &&
      props.selected() === target.origin &&
      sessionsById().get(target.session.id)?.revision === target.session.revision
    ) {
      actions.set(target);
    }
  };
  const closeActions = () => {
    batch(() => {
      actions.set(null);
    });
  };
  effect(() => {
    const target = actions();
    if (target && props.selected() !== target.origin) closeActions();
  });
  const chooseFilter = (filter: 'all' | 'archived' | 'needs_you') => {
    browser.setFilter(filter);
    list?.scrollToIndex({ index: 0, animated: false });
  };
  const chooseScope = (scope: BrowserScope) => {
    if (!alive) return;
    batch(() => {
      browser.setScope(scope);
      choosingWorkspace.set(false);
    });
    list?.scrollToIndex({ index: 0, animated: false });
    navigationTarget?.focus();
  };
  const escape = () => {
    if (actions() || automationsOpen() || moreFeaturesOpen()) return;
    if (choosingWorkspace()) {
      choosingWorkspace.set(false);
      navigationTarget?.focus();
    } else props.close();
  };
  const focusBrowser = () => {
    if (!props.focusRequest() || !navigationTarget) return;
    choosingWorkspace.set(false);
    navigationTarget.focus();
    props.focusHandled();
  };
  effect(() => {
    if (props.focusRequest()) untracked(focusBrowser);
  });
  // Hidden rows can extend a page without making the List emit its end edge again.
  const endRequest = signal<{
    rows: number;
    loaded: number;
    scope: BrowserScope;
    filter: ReturnType<Browsing['filter']>;
  } | null>(null);
  const loadMore = () => {
    if (!choosingWorkspace())
      endRequest.set({
        rows: rowIds().length,
        loaded: browser.sessions().length,
        scope: browser.scope(),
        filter: browser.filter(),
      });
  };
  const showOlder = () => {
    const request = endRequest();
    return (
      platform.idiom !== 'terminal' &&
      !!request &&
      browser.hasMore() &&
      !browser.error() &&
      request.scope === browser.scope() &&
      request.filter === browser.filter() &&
      rowIds().length === request.rows &&
      browser.sessions().length > request.loaded &&
      groups().some(
        (group) =>
          !collapsed().has(group.key) &&
          !expanded().has(group.key) &&
          topLevelCount(group) > projectSessionLimit(group),
      )
    );
  };
  effect(() => {
    const rows = rowIds().length;
    const requested = endRequest();
    if (
      requested &&
      (browser.scope() !== requested.scope ||
        browser.filter() !== requested.filter ||
        rows > requested.rows)
    ) {
      endRequest.set(null);
      return;
    }
    if (requested && rows < requested.rows) {
      endRequest.set({ ...requested, rows });
      return;
    }
    if (choosingWorkspace() || browser.loading() || browser.error() || showOlder()) return;
    if (!requested && browser.hasMore() && rows < Math.ceil(viewportHeight() / rowHeight())) {
      loadMore();
    } else if (requested) {
      void browser.loadMore().then((result) => {
        if (alive && endRequest() === requested && result === 'complete') endRequest.set(null);
      });
    }
  });
  const createWorkspace = ({
    workspace,
    origin,
    label,
  }: {
    workspace: BrowserWorkspace;
    origin: string | null;
    label: string;
  }) => {
    if (alive && props.selected() === origin && !props.switching())
      void props.create(workspace, origin, label);
  };
  const toggleScopes = () => {
    choosingWorkspace.set(!choosingWorkspace());
  };
  const refresh = () => {
    void browser.refresh();
  };
  const showBotNav = () =>
    props.openBot !== undefined &&
    (platform.idiom === 'terminal' ||
      sidebarPreferences.isPinned('bot') ||
      botSelected() ||
      activeBotWorkers().length > 0);
  const showAutomationsNav = () =>
    platform.idiom === 'terminal' || sidebarPreferences.isPinned('automations');
  const showRoomsNav = () =>
    props.openRooms !== undefined &&
    (platform.idiom === 'terminal' || sidebarPreferences.isPinned('rooms'));
  const optionalFeatures = computed<
    Array<{
      id: SidebarFeature;
      icon: 'bot' | 'activity' | 'rooms';
      label: string;
      disabled: boolean;
      open(): void;
    }>
  >(() => [
    ...(props.openBot !== undefined
      ? [
          {
            id: 'bot' as const,
            icon: 'bot' as const,
            label: tr('Maka Bot'),
            disabled: props.switching(),
            open: () => {
              setMoreFeaturesOpen(false);
              props.openBot?.(props.selected());
            },
          },
        ]
      : []),
    {
      id: 'automations' as const,
      icon: 'activity' as const,
      label: tr('Automations'),
      disabled: props.connectionLost(),
      open: () => {
        setMoreFeaturesOpen(false);
        automationsOpen.set(true);
      },
    },
    ...(props.openRooms !== undefined
      ? [
          {
            id: 'rooms' as const,
            icon: 'rooms' as const,
            label: tr('Rooms'),
            disabled: props.switching(),
            open: () => {
              setMoreFeaturesOpen(false);
              props.openRooms?.();
            },
          },
        ]
      : []),
  ]);
  const workspaceLabel = (workspace: { projectId?: string | null; path: string }) => {
    const project = workspace.projectId ? projectsById().get(workspace.projectId) : undefined;
    return project?.name ?? (workspace.path.split('/').filter(Boolean).at(-1) || workspace.path);
  };
  return (
    <View
      ref={(node) => {
        props.attach(node);
        removeEscape();
        removeEscape = keymap.bind('escape', escape, { when: 'always', within: node });
      }}
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: C.chrome,
        padding: 12,
        // Docked, its top row is the window's title bar there.
        paddingTop: titleBarRow() ? 0 : 12,
        gap: 8,
      }}
    >
      <If when={platform.idiom === 'terminal'}>
        <View
          desktop={titleBarRow() ? windowDrag : undefined}
          style={{
            height: titleBarRow() ? TITLE_BAR_HEIGHT : compact() ? 32 : 40,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Image src={logo} style={[{ width: 24, height: 24 }, { objectFit: 'contain' }]} />
          <Text style={{ color: C.text, fontSize: 14, lineHeight: 24, fontWeight: '600', flex: 1 }}>
            Maka
          </Text>
        </View>
      </If>
      <If when={platform.idiom !== 'terminal' && titleBarRow()}>
        <SidebarTitleRow
          toggle={inputAction(props.collapse, props.selected())}
          pin={props.pinSidebar}
          suppressHover={props.suppressSidebarHover}
        />
      </If>
      <View style={{ gap: platform.idiom === 'terminal' ? 8 : 2 }}>
        <Button
          accessibilityLabel={tr('New conversation')}
          ref={(node) => {
            if (platform.idiom === 'terminal') return;
            navigationTarget = node;
            focusBrowser();
          }}
          disabled={props.switching()}
          onPress={inputAction(props.newConversation, props.selected())}
          style={{
            backgroundColor: platform.idiom === 'terminal' ? C.raised : 'transparent',
            height: navigationRowHeight(),
            flexDirection: 'row',
            gap: 8,
            paddingHorizontal: 8,
            paddingVertical: 8,
            alignItems: 'center',
            borderRadius: 8,
          }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={{ backgroundColor: C.pressed }}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="plus" color={navIcon()} />
          <Text style={{ color: navText(), fontSize: 14 }}>{tr('New conversation')}</Text>
        </Button>
        <If when={platform.idiom === 'terminal'}>
          <Button
            accessibilityLabel={tr('Choose workspace scope')}
            ref={(node) => {
              navigationTarget = node;
              focusBrowser();
            }}
            onPress={inputAction(toggleScopes, null)}
            style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={{ backgroundColor: C.pressed }}
          >
            <Icon name="folder" color={C.secondary} />
            <Text style={[{ color: C.secondary, flex: 1, fontSize: 13 }, { numberOfLines: 1 }]}>
              {scopeLabel()}
            </Text>
            <Icon name="down" color={C.secondary} />
          </Button>
        </If>
        <Button
          accessibilityLabel={tr('Search conversations')}
          tooltip={textTooltip(() => `${tr('Search conversations')} · ${keymap.label('mod+o')}`)}
          onPress={inputAction(props.search, props.selected())}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
            gap: 8,
            height: 32,
            backgroundColor: platform.idiom === 'terminal' ? C.background : 'transparent',
            borderRadius: 8,
          }}
          hoverStyle={
            platform.idiom === 'terminal' ? controlHoverStyle() : { backgroundColor: C.raised }
          }
          focusStyle={
            platform.idiom === 'terminal' ? controlFocusStyle() : { backgroundColor: C.pressed }
          }
        >
          <Icon name="search" color={navIcon()} />
          <If
            when={platform.idiom === 'terminal'}
            else={
              <Text style={[{ color: navText(), flex: 1, fontSize: 14 }, { numberOfLines: 1 }]}>
                {tr('Search conversations')}
              </Text>
            }
          >
            <Text style={[{ color: C.muted, flex: 1, fontSize: 13 }, { numberOfLines: 1 }]}>
              {tr('Search titles and messages…')}
            </Text>
          </If>
        </Button>
        <If when={showBotNav()}>
          <Button
            accessibilityLabel={tr('Maka Bot')}
            disabled={props.switching()}
            onPress={inputAction(
              (origin: string | null) => props.openBot?.(origin),
              props.selected(),
            )}
            style={{
              backgroundColor: botSelected()
                ? platform.idiom === 'terminal'
                  ? C.line
                  : C.raised
                : 'transparent',
              height: navigationRowHeight(),
              flexDirection: 'row',
              gap: 8,
              paddingHorizontal: 8,
              paddingVertical: 8,
              alignItems: 'center',
              borderRadius: 8,
            }}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={{ backgroundColor: C.pressed }}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="bot" color={navIcon()} />
            <Text style={selectedNavText(botSelected())}>{tr('Maka Bot')}</Text>
          </Button>
          <Each of={shownBotWorkers()} key={(worker) => worker.id}>
            {(worker) => (
              <View style={{ height: navigationRowHeight(), paddingLeft: nestInset }}>
                <GuideLine
                  last={() =>
                    moreBotWorkers() === 0 && shownBotWorkers().at(-1)?.id === worker().id
                  }
                  height={navigationRowHeight}
                />
                <Button
                  accessibilityLabel={tr('Open conversation {title}', {
                    title: worker().title || tr('Untitled conversation'),
                  })}
                  disabled={props.switching()}
                  selected={props.selected() === worker().id}
                  onPress={inputAction(select, { id: worker().id, origin: props.selected() })}
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                    backgroundColor: props.selected() === worker().id ? C.raised : 'transparent',
                  }}
                  hoverStyle={{ backgroundColor: C.raised }}
                  focusStyle={{ backgroundColor: C.raised }}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text
                    style={[
                      { color: navText(), fontSize: 13, flex: 1, minWidth: 0 },
                      { numberOfLines: 1 },
                    ]}
                  >
                    {worker().title || tr('Untitled conversation')}
                  </Text>
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: worker().activity === 'waiting' ? C.accentText : C.muted,
                    }}
                  >
                    {worker().activity === 'idle' ? '' : sessionStatusCaption[worker().activity]}
                  </Text>
                </Button>
              </View>
            )}
          </Each>
          <If when={moreBotWorkers() > 0}>
            <View style={{ height: navigationRowHeight(), paddingLeft: nestInset }}>
              <GuideLine last={() => true} height={navigationRowHeight} />
              <Button
                accessibilityLabel={tr('{count} more in Maka Bot', { count: moreBotWorkers() })}
                disabled={props.switching()}
                onPress={inputAction(
                  (origin: string | null) => props.openBot?.(origin),
                  props.selected(),
                )}
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  paddingHorizontal: 8,
                  borderRadius: 8,
                }}
                hoverStyle={{ backgroundColor: C.raised }}
                focusStyle={{ backgroundColor: C.raised }}
              >
                <Text style={{ ...captionTextStyle, color: C.muted }}>
                  {tr('workspace.more_count', { count: moreBotWorkers() })}
                </Text>
              </Button>
            </View>
          </If>
        </If>
        <If when={showAutomationsNav()}>
          <Button
            accessibilityLabel={tr('Automations')}
            disabled={props.connectionLost()}
            onPress={() => automationsOpen.set(true)}
            style={{
              ...controlStyle,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 8,
              height: navigationRowHeight(),
              borderRadius: 8,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="activity" color={navIcon()} />
            <Text style={{ color: navText(), flex: 1, fontSize: 14 }}>{tr('Automations')}</Text>
          </Button>
        </If>
        <If when={showRoomsNav()}>
          <Button
            accessibilityLabel={tr('Rooms')}
            disabled={props.switching()}
            onPress={() => props.openRooms?.()}
            style={{
              ...controlStyle,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 8,
              height: navigationRowHeight(),
              borderRadius: 8,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="rooms" color={navIcon()} />
            <Text style={{ color: navText(), flex: 1, fontSize: 14 }}>{tr('Rooms')}</Text>
          </Button>
        </If>
        <If when={platform.idiom === 'terminal' && browser.filter() !== 'archived'}>
          <Button
            accessibilityLabel={tr('Waiting for you')}
            selected={browser.filter() === 'needs_you'}
            onPress={inputAction(
              chooseFilter,
              browser.filter() === 'needs_you' ? 'all' : 'needs_you',
            )}
            style={{
              ...controlStyle,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 8,
              height: navigationRowHeight(),
              borderRadius: 8,
            }}
            selectedStyle={{ backgroundColor: C.raised }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Icon name="inbox" color={navIcon()} />
            <Text style={{ ...selectedNavText(browser.filter() === 'needs_you'), flex: 1 }}>
              {tr('Waiting for you')}
            </Text>
            <Text style={{ color: C.secondary }}>{browser.needsYouCount()}</Text>
          </Button>
        </If>
        <If when={platform.idiom !== 'terminal'}>
          <Popover
            open={moreFeaturesOpen()}
            onOpenChange={({ open }) => setMoreFeaturesOpen(open)}
            align="start"
            offset={4}
            margin={8}
            popupStyle={{
              ...floatingStyle(),
              width: 232,
              padding: 4,
              gap: 2,
            }}
            trigger={
              <Button
                accessibilityLabel={tr('More features')}
                selected={moreFeaturesOpen()}
                style={{
                  ...controlStyle,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 8,
                  height: navigationRowHeight(),
                  borderRadius: 8,
                }}
                selectedStyle={{ backgroundColor: C.raised }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Icon name="mosaic" color={C.muted} />
                <Text style={{ color: C.muted, flex: 1, fontSize: 14 }}>{tr('More features')}</Text>
              </Button>
            }
          >
            <Text
              style={{
                ...captionTextStyle,
                color: C.muted,
                fontWeight: '500',
                paddingHorizontal: 8,
                paddingVertical: 6,
              }}
            >
              {tr('Sidebar features')}
            </Text>
            <Each of={optionalFeatures()} key={(item) => item.id}>
              {(item) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', height: 32 }}>
                  <Button
                    accessibilityLabel={item().label}
                    disabled={item().disabled}
                    onPress={() => item().open()}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      height: 32,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      paddingHorizontal: 8,
                      borderRadius: 8,
                    }}
                    hoverStyle={{ backgroundColor: C.floatingRaised }}
                    focusStyle={{ backgroundColor: C.floatingRaised }}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Icon name={item().icon} color={C.muted} />
                    <Text style={[{ color: C.text, flex: 1, fontSize: 14 }, { numberOfLines: 1 }]}>
                      {item().label}
                    </Text>
                  </Button>
                  <Switch
                    accessibilityLabel={tr('Show {name} in sidebar', { name: item().label })}
                    checked={sidebarPreferences.isPinned(item().id)}
                    onChange={() => sidebarPreferences.toggleFeature(item().id)}
                    style={{
                      height: 32,
                      paddingHorizontal: 8,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 8,
                    }}
                    trackClass="w-[32px] h-[16px] p-[3px] rounded-full flex-row items-center checked:justify-end"
                    trackStyle={{
                      backgroundColor: sidebarPreferences.isPinned(item().id) ? C.accent : C.line,
                    }}
                    thumbClass="size-[10px] rounded-full"
                    thumbStyle={{
                      backgroundColor: sidebarPreferences.isPinned(item().id)
                        ? C.onAccent
                        : C.secondary,
                    }}
                    hoverStyle={{ backgroundColor: C.floatingRaised }}
                    focusStyle={{ backgroundColor: C.floatingRaised }}
                  />
                </View>
              )}
            </Each>
          </Popover>
        </If>
      </View>
      <If when={props.openRooms === undefined}>{props.navigationMore?.()}</If>
      <If when={platform.idiom !== 'terminal' && browser.filter() !== 'archived'}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            height: 32,
            marginTop: 8,
          }}
        >
          <Text
            style={{
              ...captionTextStyle,
              fontWeight: '500',
              color: C.secondary,
              flex: 1,
              paddingLeft: 8,
            }}
          >
            {tr('Conversations')}
          </Text>
          <Button
            accessibilityLabel={sortByTime() ? tr('Group by project') : tr('Sort by time')}
            tooltip={textTooltip(() =>
              sortByTime() ? tr('Group by project') : tr('Sort by time'),
            )}
            onPress={() => sidebarPreferences.toggleSortMode()}
            style={{
              height: 32,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
              borderRadius: 8,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr(sortByTime() ? 'By time' : 'By project')}
            </Text>
            <Icon name="down" size={14} color={C.muted} />
          </Button>
        </View>
      </If>
      <If when={platform.idiom === 'terminal'}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            padding: compact() ? 0 : 4,
            backgroundColor: C.background,
            borderRadius: 8,
          }}
        >
          <Button
            selected={browser.filter() === 'all'}
            accessibilityLabel={tr('Show active conversations')}
            style={{ ...controlStyle, flex: 1, alignItems: 'center', paddingHorizontal: 8 }}
            selectedStyle={{ backgroundColor: C.raised }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            onPress={inputAction(chooseFilter, 'all')}
          >
            <Text style={{ color: browser.filter() === 'all' ? C.text : C.muted }}>
              {tr('Active')}
            </Text>
          </Button>
          <Button
            selected={browser.filter() === 'archived'}
            accessibilityLabel={tr('Show archived conversations')}
            style={{ ...controlStyle, flex: 1, alignItems: 'center', paddingHorizontal: 8 }}
            selectedStyle={{ backgroundColor: C.raised }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            onPress={inputAction(chooseFilter, 'archived')}
          >
            <Text style={{ color: browser.filter() === 'archived' ? C.text : C.muted }}>
              {tr('Archived')}
            </Text>
          </Button>
        </View>
      </If>
      <If when={platform.idiom !== 'terminal' && browser.filter() === 'archived'}>
        <Button
          accessibilityLabel={tr('Show active conversations')}
          onPress={inputAction(chooseFilter, 'all')}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            justifyContent: 'flex-start',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 8,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="back" color={C.secondary} />
          <Text style={{ color: C.text, fontWeight: '600' }}>{tr('Archived')}</Text>
        </Button>
      </If>
      <If
        when={
          rowIds().length > 0 &&
          !props.connectionLost() &&
          Boolean(browser.error() || browser.projectError())
        }
      >
        <InlineCallout
          surface="chrome"
          tone="danger"
          message={String(browser.error() || browser.projectError())}
          action={{ label: tr('Refresh'), onPress: inputAction(refresh, null) }}
        />
      </If>
      <List
        ref={(node) => {
          list = node;
        }}
        each={rowIds()}
        estimatedItemSize={rowHeight()}
        empty={() => (
          <View
            style={{ height: viewportHeight(), alignItems: 'center', justifyContent: 'center' }}
          >
            <If
              when={!props.connectionLost() && Boolean(browser.error() || browser.projectError())}
              else={
                <If when={!browser.loading()}>
                  <Text style={{ color: C.muted }}>
                    {browser.filter() === 'archived'
                      ? tr('No archived conversations.')
                      : tr('No conversations yet.')}
                  </Text>
                </If>
              }
            >
              <RegionEmptyError
                compact
                surface="chrome"
                tone="danger"
                title={String(browser.error() || browser.projectError())}
                retry={inputAction(refresh, null)}
                retryLabel={tr('Refresh browser')}
              />
            </If>
          </View>
        )}
        onLayout={({ bounds: frame }) => viewportHeight.set(frame.size.height)}
        onLoadMore={loadMore}
        footer={() => (
          <If when={showOlder()}>
            <Button
              onPress={loadMore}
              style={{
                height: 28,
                justifyContent: 'center',
                paddingHorizontal: 8,
                borderRadius: 8,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Load older conversations')}
              </Text>
            </Button>
          </If>
        )}
        style={{ flex: 1, minHeight: 32 }}
        accessibilityLabel={choosingWorkspace() ? tr('Workspace scopes') : tr('Conversations')}
      >
        {(id) => (
          <Each of={[id()]} key={(key: string) => key}>
            {(key) => {
              if (choosingWorkspace()) {
                const initial = scopesById().get(key());
                if (!initial) return <View />;
                const scope = () => scopesById().get(key()) ?? initial;
                const project = () =>
                  browser.projects().find((project) => project.reference.id === key());
                return (
                  <View
                    style={{
                      flexDirection: 'row',
                      height: compact() ? 32 : 48,
                      paddingVertical: compact() ? 0 : 2,
                    }}
                  >
                    <Button
                      disabled={!scopesById().has(key())}
                      onPress={inputAction(chooseScope, scope().scope)}
                      style={{
                        flex: 1,
                        paddingHorizontal: 8,
                        justifyContent: 'center',
                        borderRadius: 8,
                      }}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                    >
                      <Text style={[{ color: C.text }, { numberOfLines: 1 }]}>
                        {scope()?.title}
                      </Text>
                      <Text style={[{ color: C.muted }, { numberOfLines: 1 }]}>
                        {scope()?.detail}
                      </Text>
                    </Button>
                    <If when={project()}>
                      <Button
                        accessibilityLabel={tr('New conversation in {name}', {
                          name: project()?.name ?? '',
                        })}
                        disabled={props.switching() || !project()?.available || !project()?.path}
                        onPress={
                          project()?.path
                            ? inputAction(createWorkspace, {
                                workspace: {
                                  kind: 'project',
                                  projectId: project()!.reference.id,
                                  path: project()!.path!,
                                },
                                origin: props.selected(),
                                label: project()!.path ?? project()!.name,
                              })
                            : undefined
                        }
                      >
                        <Text style={{ color: C.accentText }}> + </Text>
                      </Button>
                    </If>
                  </View>
                );
              }
              if (key().startsWith('show-more:')) {
                const groupKey = key().slice('show-more:'.length);
                const open = () => expanded().has(groupKey);
                const hiddenCount = () => {
                  const group = groupsById().get(groupKey);
                  if (!group) return 0;
                  const all = shownSessions(group);
                  return Math.max(
                    0,
                    all.length - withinLimit(group, all, projectSessionLimit(group)).length,
                  );
                };
                return (
                  <View style={{ flexDirection: 'row', height: 28 }}>
                    <Button
                      accessibilityLabel={tr(
                        open()
                          ? 'Show fewer conversations in {name}'
                          : 'Show more conversations in {name}',
                        { name: groupsById().get(groupKey)?.name ?? '' },
                      )}
                      onPress={inputAction(toggleProjectSessions, groupKey)}
                      style={{
                        flex: 1,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 8,
                        borderRadius: 8,
                      }}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                    >
                      <Text style={{ ...captionTextStyle, color: C.muted }}>
                        {open()
                          ? tr('Show fewer project conversations')
                          : tr('Show {count} more conversations', { count: hiddenCount() })}
                      </Text>
                      <Icon name={open() ? 'up' : 'down'} size={14} color={C.muted} />
                    </Button>
                  </View>
                );
              }
              if (key().startsWith('family:')) {
                const parent = key().slice('family:'.length);
                const members = () =>
                  (families().get(parent) ?? []).flatMap((id) => sessionsById().get(id) ?? []);
                const open = () => !foldedFamilies().has(parent);
                const activityKnown = () => !props.connectionLost() && !browser.error();
                // While folded the row stands in for its members' activity.
                const waiting = () =>
                  !open() &&
                  activityKnown() &&
                  members().some((member) => member.activity === 'waiting');
                const lane = () =>
                  open()
                    ? null
                    : activityKnown() && members().some((member) => member.activity === 'working')
                      ? 'working'
                      : members().some((member) => member.hasUnread)
                        ? 'unread'
                        : null;
                const title = () =>
                  sessionsById().get(parent)?.title || tr('Untitled conversation');
                return (
                  <View
                    style={{
                      flexDirection: 'row',
                      height: rowHeight(),
                      paddingVertical: compact() ? 0 : 2,
                      paddingLeft: nestInset,
                    }}
                  >
                    <GuideLine last={() => !open()} height={rowHeight} />
                    <Button
                      accessibilityLabel={tr(
                        open()
                          ? 'Fold the conversations {title} created'
                          : 'Show the conversations {title} created',
                        { title: title() },
                      )}
                      onPress={inputAction(toggleFamily, parent)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                        paddingHorizontal: 8,
                        borderRadius: 8,
                      }}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                    >
                      <Text style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}>
                        {tr('{count} created conversations', { count: members().length })}
                      </Text>
                      <Icon name={open() ? 'down' : 'right'} color={C.muted} />
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.accentText, flex: 1, minWidth: 0 },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {waiting() ? sessionStatusCaption.waiting : ''}
                      </Text>
                      <View
                        style={[
                          { width: 16, alignItems: 'center', justifyContent: 'center' },
                          { pointerEvents: 'none' },
                        ]}
                      >
                        <If when={lane() === 'working'}>
                          <LoadingIndicator size={12} label={sessionStatusCaption.working} />
                        </If>
                        <If when={lane() === 'unread'}>
                          <View
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 3,
                              backgroundColor: C.accent,
                            }}
                          />
                        </If>
                      </View>
                    </Button>
                  </View>
                );
              }
              const groupKey = key().startsWith('group:') ? key().slice('group:'.length) : '';
              const initialGroup = groupsById().get(groupKey);
              if (initialGroup) {
                const group = () => groupsById().get(groupKey) ?? initialGroup;
                if (initialGroup.key.startsWith('time:')) {
                  return (
                    <View
                      style={{
                        height: compact() ? 24 : 28,
                        justifyContent: 'center',
                        paddingHorizontal: 8,
                        marginTop: key() === rowIds()[0] ? 0 : 8,
                      }}
                    >
                      <Text style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}>
                        {group().name}
                      </Text>
                    </View>
                  );
                }
                const open = () => !collapsed().has(group().key);
                const workspace = () => groupWorkspace(group());
                return (
                  <View
                    style={{
                      flexDirection: 'row',
                      height: 28,
                      // Each workspace after the first starts its own block.
                      marginTop: key() === rowIds()[0] ? 0 : 8,
                    }}
                  >
                    <Button
                      accessibilityLabel={tr(open() ? 'Collapse {name}' : 'Expand {name}', {
                        name: group().name,
                      })}
                      onPress={inputAction(toggleGroup, group().key)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 8,
                        borderRadius: 8,
                      }}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                    >
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.muted, flexShrink: 1 },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {group().name}
                      </Text>
                      <Icon name={open() ? 'down' : 'right'} size={14} color={C.muted} />
                    </Button>
                    <If when={workspace() !== null && browser.filter() === 'all'}>
                      <Button
                        accessibilityLabel={tr('New conversation in {name}', {
                          name: group().name,
                        })}
                        tooltip={textTooltip(() =>
                          tr('New conversation in {name}', { name: group().name }),
                        )}
                        disabled={props.switching()}
                        onPress={inputAction(createWorkspace, {
                          workspace: workspace()!,
                          origin: props.selected(),
                          label: group().project?.path ?? group().name,
                        })}
                        style={{
                          width: 32,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 8,
                        }}
                        hoverStyle={controlHoverStyle()}
                        focusStyle={controlFocusStyle()}
                        disabledStyle={controlDisabledStyle}
                      >
                        <Icon name="plus" color={C.muted} />
                      </Button>
                    </If>
                  </View>
                );
              }
              const session = () => sessionsById().get(key());
              const showActions = (target: {
                session: SessionActionTarget;
                origin: string | null;
                action: SessionMenuAction;
              }) => {
                if (target.session.id === key()) openActions(target);
              };
              // On the desktop the More button sits inside the row and shows on
              // the selected row, while the pointer is on the row, or while its
              // menu is open.
              const hovered = signal(false);
              const menuOpen = signal(false);
              const menuItems = () => {
                const target = {
                  session: sessionActionTarget(session()!),
                  origin: props.selected(),
                };
                return (
                  <SessionMenuItems
                    session={target.session}
                    childrenAvailable
                    besideAvailable={Boolean(
                      props.canOpenBeside?.() &&
                        target.session.id !== props.selected() &&
                        !props.beside?.().includes(target.session.id),
                    )}
                    select={(action) => showActions({ ...target, action })}
                  />
                );
              };
              // The conversation that created this one, when the list shows it
              // elsewhere rather than just above (the row has no room to say).
              const creator = () => {
                const parent = session()?.parentSessionId;
                return parent && !nestedRows().has(key()) ? sessionsById().get(parent) : undefined;
              };
              // The Bot is not in this list, so its workers cannot nest under it; mark them
              // with the Bot's own icon (a text caption would shorten the title).
              const botWorker = () => {
                const parent = session()?.parentSessionId;
                return parent != null && parent === props.botSession?.();
              };
              const activityKnown = () => !props.connectionLost() && !browser.error();
              // The desktop names the workspace only where the group does not.
              const desktopCaption = () => {
                const current = session();
                if (!current) return '';
                return [
                  activityKnown() && current.activity === 'waiting'
                    ? sessionStatusCaption.waiting
                    : '',
                  branchCaption(current),
                  current.pinned || sortByTime() ? workspaceLabel(current.workspace) : '',
                ]
                  .filter(Boolean)
                  .join(' · ');
              };
              const actionsShown = () =>
                platform.idiom === 'terminal' ||
                hovered() ||
                menuOpen() ||
                props.selected() === key() ||
                actions()?.session.id === key();
              const current = () => props.selected() === key();
              // What the row's end shows while its More button is away: the
              // desktop's one lane for a running conversation or an unread one.
              const lane = () =>
                activityKnown() && session()?.activity === 'working'
                  ? 'working'
                  : session()?.hasUnread
                    ? 'unread'
                    : null;
              return (
                <View>
                  <If
                    when={
                      platform.idiom === 'terminal' &&
                      hasPinned() &&
                      (key() === visibleSessions()[0]?.id || key() === firstUnpinned())
                    }
                  >
                    <Text
                      style={{
                        ...captionTextStyle,
                        color: C.muted,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                      }}
                    >
                      {session()?.pinned ? tr('Pinned') : tr('Conversations')}
                    </Text>
                  </If>
                  <ContextMenu
                    disabled={!session() || props.switching()}
                    offset={4}
                    margin={8}
                    popupStyle={floatingStyle()}
                    onOpenChange={({ open }) => menuOpen.set(open)}
                    trigger={
                      <View
                        style={{
                          flexDirection: 'row',
                          height: rowHeight(),
                          paddingVertical: compact() ? 0 : 2,
                          // Under the conversation that created it.
                          paddingLeft:
                            platform.idiom !== 'terminal' && nestedRows().has(key())
                              ? nestInset
                              : 0,
                        }}
                      >
                        <If when={platform.idiom !== 'terminal' && nestedRows().has(key())}>
                          <GuideLine last={() => lastNestedRows().has(key())} height={rowHeight} />
                        </If>
                        <View
                          onMouseEnter={() => hovered.set(true)}
                          onMouseLeave={() => hovered.set(false)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            flexDirection: 'row',
                            borderRadius: 8,
                            ...(platform.idiom === 'terminal'
                              ? {}
                              : {
                                  backgroundColor:
                                    current() || props.beside?.().includes(key()) || hovered()
                                      ? C.raised
                                      : 'transparent',
                                }),
                          }}
                        >
                          <Button
                            accessibilityLabel={tr('Open conversation {title}', {
                              title: session()?.title || tr('Untitled conversation'),
                            })}
                            disabled={props.switching() || !session()}
                            selected={props.selected() === key()}
                            tooltip={
                              platform.idiom === 'terminal'
                                ? undefined
                                : textTooltip(() =>
                                    creator()
                                      ? tr('From {title}', {
                                          title: creator()!.title || tr('Untitled conversation'),
                                        })
                                      : botWorker()
                                        ? tr('From {title}', { title: tr('Maka Bot') })
                                        : undefined,
                                  )
                            }
                            onPress={inputAction(select, { id: key(), origin: props.selected() })}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              paddingHorizontal: 8,
                              justifyContent: 'center',
                              borderRadius: 8,
                              backgroundColor:
                                platform.idiom === 'terminal'
                                  ? props.selected() === key()
                                    ? C.line
                                    : C.surface
                                  : 'transparent',
                            }}
                            hoverStyle={
                              platform.idiom === 'terminal' ? { backgroundColor: C.line } : {}
                            }
                            focusStyle={{ backgroundColor: C.raised }}
                          >
                            <View
                              style={[
                                { flexDirection: 'row', alignItems: 'center', gap: 8 },
                                { pointerEvents: 'none' },
                              ]}
                            >
                              <Text
                                style={[
                                  platform.idiom === 'terminal'
                                    ? {
                                        color:
                                          current() || session()?.hasUnread ? C.accentText : C.text,
                                        flex: 1,
                                      }
                                    : {
                                        color: C.text,
                                        fontWeight: current() ? '500' : undefined,
                                        flex: 1,
                                      },
                                  { numberOfLines: 1 },
                                ]}
                              >
                                {session()?.title || tr('Untitled conversation')}
                              </Text>
                              <If when={platform.idiom !== 'terminal' && desktopCaption()}>
                                <Text
                                  style={[
                                    { ...captionTextStyle, color: C.muted, flexShrink: 1 },
                                    { numberOfLines: 1 },
                                  ]}
                                >
                                  {desktopCaption()}
                                </Text>
                              </If>
                              <If when={platform.idiom !== 'terminal' && botWorker()}>
                                <Icon name="bot" color={C.muted} />
                              </If>
                              <If when={platform.idiom === 'terminal' && session()?.hasUnread}>
                                <Icon name="unread" color={C.accentText} />
                              </If>
                            </View>
                            <If when={platform.idiom === 'terminal'}>
                              <Text
                                style={[
                                  { color: C.muted, fontSize: 12, lineHeight: 16 },
                                  { numberOfLines: 1 },
                                ]}
                              >
                                {props.connectionLost() || browser.error()
                                  ? ''
                                  : session()?.activity === 'working'
                                    ? `${sessionStatusCaption.working} · `
                                    : session()?.activity === 'waiting'
                                      ? `${sessionStatusCaption.waiting} · `
                                      : ''}
                                {session() && branchCaption(session()!)
                                  ? `${branchCaption(session()!)} · `
                                  : ''}
                                {session()?.workspace.path.split('/').filter(Boolean).at(-1) ||
                                  session()?.workspace.path}
                              </Text>
                            </If>
                          </Button>
                          <If
                            when={
                              platform.idiom !== 'terminal' && lane() !== null && !actionsShown()
                            }
                          >
                            <View
                              style={[
                                {
                                  position: 'absolute',
                                  right: 8,
                                  top: 0,
                                  bottom: 0,
                                  width: 16,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                },
                                { pointerEvents: 'none' },
                              ]}
                            >
                              <If
                                when={lane() === 'working'}
                                else={
                                  <View
                                    style={{
                                      width: 6,
                                      height: 6,
                                      borderRadius: 3,
                                      backgroundColor: C.accent,
                                    }}
                                  />
                                }
                              >
                                <LoadingIndicator size={12} label={sessionStatusCaption.working} />
                              </If>
                            </View>
                          </If>
                          <Menu
                            offset={4}
                            margin={8}
                            align="end"
                            popupStyle={floatingStyle()}
                            onOpenChange={({ open }) => menuOpen.set(open)}
                            trigger={
                              <Button
                                accessibilityLabel={tr('Actions for {title}', {
                                  title: session()?.title || tr('Untitled conversation'),
                                })}
                                disabled={props.switching() || !session()}
                                style={{
                                  width: 32,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  borderRadius: 8,
                                  opacity: actionsShown() ? 1 : 0,
                                }}
                                hoverStyle={controlHoverStyle()}
                                // Closing the menu returns focus here, and a click elsewhere
                                // keeps it, so the desktop shows focus as the icon alone.
                                focusStyle={
                                  platform.idiom === 'terminal'
                                    ? controlFocusStyle()
                                    : { opacity: 1 }
                                }
                              >
                                <Icon name="more" color={C.muted} />
                              </Button>
                            }
                          >
                            {menuItems()}
                          </Menu>
                        </View>
                      </View>
                    }
                  >
                    {menuItems()}
                  </ContextMenu>
                </View>
              );
            }}
          </Each>
        )}
      </List>
      <If when={browser.loading()}>
        <LoadingIndicator />
      </If>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          ...(platform.idiom === 'terminal'
            ? { paddingTop: 8, borderTopWidth: 1, borderTopColor: C.line }
            : {}),
        }}
      >
        <Button
          accessibilityLabel={tr('Open settings')}
          // The application menu owns ⌘, only where the app draws its own title bar.
          tooltip={textTooltip(() =>
            ownTitleBar ? `${tr('Settings')} · ${keymap.label('mod+,')}` : undefined,
          )}
          onPress={inputAction(props.settings, props.selected())}
          // Starts where New conversation's icon and label do, like the rows above it.
          style={{
            ...controlStyle,
            flex: 1,
            flexDirection: 'row',
            justifyContent: 'flex-start',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 8,
          }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={{ backgroundColor: C.pressed }}
        >
          <Icon name="settings" color={navIcon()} />
          <Text style={{ color: C.secondary }}>{tr('Settings')}</Text>
        </Button>
        <If when={platform.idiom !== 'terminal'}>
          <Button
            selected={browser.filter() === 'archived'}
            accessibilityLabel={tr(
              browser.filter() === 'archived'
                ? 'Show active conversations'
                : 'Show archived conversations',
            )}
            tooltip={textTooltip(() => tr('Archived'))}
            onPress={inputAction(
              chooseFilter,
              browser.filter() === 'archived' ? 'all' : 'archived',
            )}
            style={{ ...controlStyle, width: 32, alignItems: 'center', justifyContent: 'center' }}
            selectedStyle={{ backgroundColor: C.raised }}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={{ backgroundColor: C.pressed }}
          >
            <Icon name="archive" color={navIcon()} />
          </Button>
        </If>
        <SidebarUpdateButton holdSidebarHover={props.holdSidebarHover} />
      </View>
      <If when={automationsOpen()}>
        <Automations
          selected={props.selected}
          close={() => automationsOpen.set(false)}
          openConversation={(id) => {
            automationsOpen.set(false);
            void select({ id, origin: props.selected() });
          }}
        />
      </If>
      <Each of={actions() ? [actions()!] : []} key={(target) => target}>
        {(item) => {
          const target = item();
          return (
            <SessionActions
              session={target.session}
              action={target.action}
              current={() => alive && actions() === target && props.selected() === target.origin}
              close={closeActions}
              notice={(msg) =>
                toast.show({
                  id: 'workbench.session-action-error',
                  tone: 'danger',
                  message: renderText(msg),
                })
              }
              change={(action) => props.changeSession(action, target.origin)}
              openSession={(id) => {
                void select({ id, origin: target.origin });
              }}
              openBeside={
                props.canOpenBeside?.() &&
                target.session.id !== props.selected() &&
                !props.beside?.().includes(target.session.id)
                  ? () => props.openBeside?.(target.session.id)
                  : undefined
              }
            />
          );
        }}
      </Each>
    </View>
  );
}

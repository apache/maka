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

import { textTooltip } from './ui';
import { message, renderText, type UiText } from './text';
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
import type { ListRef, ViewRef } from 'nsh';
import { Button } from 'nsh/base';
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
} from './ui';
import { Icon } from './Icon';
import type { Browsing, BrowserScope, BrowserWorkspace } from './browsing';
import { SessionActions } from './SessionActions';
import {
  hasForkPrefix,
  sessionActionTarget,
  type SessionAction,
  type SessionActionTarget,
} from './sessionLifecycle';
import { sessionStatusCaption } from './sessionStatus';
import { controlsLeft, ownTitleBar, TITLE_BAR_HEIGHT, windowDrag } from './chrome';

export type WorkspaceBrowserProps = {
  docked(): boolean;
  browsing: Browsing;
  selected(): string | null;
  switching(): boolean;
  focusRequest(): boolean;
  focusHandled(): void;
  attach(node: ViewRef): void;
  close(): void;
  selectSession(id: string, expectedSessionId: string | null): Promise<void>;
  create(workspace: BrowserWorkspace, expectedSessionId: string | null): Promise<void>;
  newConversation(expectedSessionId: string | null): void;
  /** Open the persistent Bot; absent when the Bot mode is not offered. */
  openBot?(expectedSessionId: string | null): void;
  /** The Bot Session, listed only through its own entry. */
  botSession?(): string | null;
  settings(expectedSessionId: string | null): void;
  search(expectedSessionId: string | null): void;
  changeSession(action: SessionAction, expectedSessionId: string | null): Promise<void>;
};

export function WorkspaceBrowser(props: WorkspaceBrowserProps) {
  const titleBarRow = () => ownTitleBar && props.docked();
  const browser = props.browsing;
  const visibleSessions = computed(() => {
    const bot = props.botSession?.() ?? null;
    const sessions = browser.sessions();
    return bot === null ? sessions : sessions.filter((session) => session.id !== bot);
  });
  const choosingWorkspace = signal(false);
  const actions = signal<{ session: SessionActionTarget; origin: string | null } | null>(null);
  const actionsAnchor = signal<ViewRef | null>(null);
  const navigationNotice = signal<{ kind: 'draft' | 'action'; message: UiText } | null>(null);
  const viewportHeight = signal(160);
  let navigationTarget: ViewRef | undefined;
  let list: ListRef | undefined;
  let removeEscape = () => {};
  let alive = true;
  cleanup(() => {
    alive = false;
    removeEscape();
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
  const rowIds = computed(() =>
    choosingWorkspace()
      ? scopes().map((scope) => scope.id)
      : visibleSessions().map((session) => session.id),
  );
  const select = async ({ id, origin }: { id: string; origin: string | null }) => {
    if (!alive || props.selected() !== origin || props.switching()) return;
    navigationNotice.set(null);
    await props.selectSession(id, origin);
    if (alive && id !== origin && props.selected() === origin)
      navigationNotice.set({
        kind: 'draft',
        message: message(
          'The draft is not ready to save. Return to the conversation to check its status.',
        ),
      });
  };
  const openActions = (
    target: { session: SessionActionTarget; origin: string | null },
    anchor: ViewRef,
  ) => {
    if (
      alive &&
      !props.switching() &&
      props.selected() === target.origin &&
      sessionsById().get(target.session.id)?.revision === target.session.revision
    ) {
      batch(() => {
        navigationNotice.set(null);
        actionsAnchor.set(anchor);
        actions.set(target);
      });
    }
  };
  const closeActions = () => {
    batch(() => {
      actions.set(null);
      actionsAnchor.set(null);
    });
  };
  effect(() => {
    const target = actions();
    if (target && props.selected() !== target.origin) closeActions();
  });
  const chooseFilter = (filter: 'all' | 'archived') => {
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
    if (actions()) return;
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
  effect(() => {
    const rows = visibleSessions().length;
    if (
      !choosingWorkspace() &&
      !browser.loading() &&
      !browser.error() &&
      rows < Math.ceil(viewportHeight() / (compact() ? 32 : 48))
    )
      void browser.loadMore();
  });
  const createWorkspace = ({
    workspace,
    origin,
  }: {
    workspace: BrowserWorkspace;
    origin: string | null;
  }) => {
    if (alive && props.selected() === origin && !props.switching())
      void props.create(workspace, origin);
  };
  const toggleScopes = () => {
    choosingWorkspace.set(!choosingWorkspace());
  };
  const refresh = () => {
    void browser.refresh();
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
        backgroundColor: C.surface,
        padding: 12,
        // Docked, its top row is the window's title bar there.
        paddingTop: titleBarRow() ? 0 : 12,
        gap: 8,
      }}
    >
      <View
        desktop={titleBarRow() ? windowDrag : undefined}
        style={{
          height: titleBarRow() ? TITLE_BAR_HEIGHT : compact() ? 32 : 40,
          // 8 points past the window controls, inside the browser's 12.
          paddingLeft: titleBarRow() ? Math.max(0, controlsLeft(true) - 4) : 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Image src={logo} style={[{ width: 24, height: 24 }, { objectFit: 'contain' }]} />
        <Text style={{ color: C.text, fontSize: 18, lineHeight: 24, fontWeight: '600', flex: 1 }}>
          Maka
        </Text>
      </View>
      <Button
        accessibilityLabel={tr('New conversation')}
        disabled={props.switching()}
        onPress={inputAction(props.newConversation, props.selected())}
        style={{
          backgroundColor: C.raised,
          height: compact() ? 32 : 40,
          flexDirection: 'row',
          gap: 8,
          paddingHorizontal: 8,
          paddingVertical: 8,
          alignItems: 'center',
          borderRadius: 8,
        }}
        hoverStyle={{ backgroundColor: C.raised }}
        focusStyle={{ backgroundColor: C.line }}
        disabledStyle={controlDisabledStyle}
      >
        <Icon name="plus" color={C.secondary} />
        <Text style={{ color: C.text, fontSize: 14 }}>{tr('New conversation')}</Text>
      </Button>
      <If when={props.openBot !== undefined}>
        <Button
          accessibilityLabel={tr('Maka Bot')}
          disabled={props.switching()}
          onPress={inputAction(
            (origin: string | null) => props.openBot?.(origin),
            props.selected(),
          )}
          style={{
            backgroundColor:
              props.botSession?.() != null && props.selected() === props.botSession?.()
                ? C.line
                : 'transparent',
            height: compact() ? 32 : 40,
            flexDirection: 'row',
            gap: 8,
            paddingHorizontal: 8,
            paddingVertical: 8,
            alignItems: 'center',
            borderRadius: 8,
          }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={{ backgroundColor: C.line }}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="activity" color={C.accent} />
          <Text style={{ color: C.text, fontSize: 14 }}>{tr('Maka Bot')}</Text>
        </Button>
      </If>
      <Button
        accessibilityLabel={tr('Choose workspace scope')}
        ref={(node) => {
          navigationTarget = node;
          focusBrowser();
        }}
        onPress={inputAction(toggleScopes, null)}
        style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
        hoverStyle={{ backgroundColor: C.raised }}
        focusStyle={{ backgroundColor: C.line }}
      >
        <Icon name="folder" color={C.secondary} />
        <Text style={[{ color: C.secondary, flex: 1, fontSize: 13 }, { numberOfLines: 1 }]}>
          {scopeLabel()}
        </Text>
        <Icon name="down" color={C.secondary} />
      </Button>
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
          backgroundColor: C.background,
          borderRadius: 8,
        }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
      >
        <Icon name="search" color={C.secondary} />
        <Text style={[{ color: C.muted, flex: 1, fontSize: 13 }, { numberOfLines: 1 }]}>
          {tr('Search titles and messages…')}
        </Text>
      </Button>
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
      <List
        ref={(node) => {
          list = node;
        }}
        each={rowIds()}
        estimatedItemSize={compact() ? 32 : 48}
        empty={() => (
          <View
            style={{ height: viewportHeight(), alignItems: 'center', justifyContent: 'center' }}
          >
            <If when={!browser.loading() && !browser.error() && !browser.projectError()}>
              <Text style={{ color: C.muted }}>{tr('No conversations yet.')}</Text>
            </If>
          </View>
        )}
        onLayout={({ bounds: frame }) => viewportHeight.set(frame.size.height)}
        onLoadMore={() => {
          if (!choosingWorkspace()) void browser.loadMore();
        }}
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
                        disabled={
                          props.switching() || !project()?.available || !project()?.selection
                        }
                        onPress={
                          project()?.selection
                            ? inputAction(createWorkspace, {
                                workspace: {
                                  kind: 'project',
                                  project: project()!.reference,
                                  selection: project()!.selection!,
                                },
                                origin: props.selected(),
                              })
                            : undefined
                        }
                      >
                        <Text style={{ color: C.accent }}> + </Text>
                      </Button>
                    </If>
                  </View>
                );
              }
              const session = () => sessionsById().get(key());
              let actionTrigger: ViewRef | undefined;
              cleanup(() => {
                if (alive && actionsAnchor() === actionTrigger) actionsAnchor.set(null);
              });
              const showActions = (target: {
                session: SessionActionTarget;
                origin: string | null;
              }) => {
                if (actionTrigger && target.session.id === key())
                  openActions(target, actionTrigger);
              };
              // On the desktop the More button sits inside the row and shows on
              // the selected row, while the pointer is on the row, or while its
              // menu is open.
              const hovered = signal(false);
              const actionsShown = () =>
                platform.isTerminal ||
                hovered() ||
                props.selected() === key() ||
                actionsAnchor() === actionTrigger;
              return (
                <View>
                  <If
                    when={
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
                  <View
                    // A secondary click opens the row's actions, as its More button does.
                    onContextMenu={
                      session()
                        ? inputAction(showActions, {
                            session: sessionActionTarget(session()!),
                            origin: props.selected(),
                          })
                        : undefined
                    }
                    style={{
                      flexDirection: 'row',
                      height: compact() ? 32 : 48,
                      paddingVertical: compact() ? 0 : 2,
                    }}
                  >
                    <View
                      onMouseEnter={() => hovered.set(true)}
                      onMouseLeave={() => hovered.set(false)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        flexDirection: 'row',
                        borderRadius: 8,
                        ...(platform.isTerminal
                          ? {}
                          : {
                              backgroundColor:
                                props.selected() === key() || hovered() ? C.line : C.surface,
                            }),
                      }}
                    >
                      <Button
                        accessibilityLabel={tr('Open conversation {title}', {
                          title: session()?.title || tr('Untitled conversation'),
                        })}
                        disabled={props.switching() || !session()}
                        selected={props.selected() === key()}
                        onPress={inputAction(select, { id: key(), origin: props.selected() })}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          paddingHorizontal: 8,
                          justifyContent: 'center',
                          borderRadius: 8,
                          backgroundColor: platform.isTerminal
                            ? props.selected() === key()
                              ? C.line
                              : C.surface
                            : 'transparent',
                        }}
                        hoverStyle={platform.isTerminal ? { backgroundColor: C.line } : {}}
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
                              {
                                color:
                                  props.selected() === key() || session()?.hasUnread
                                    ? C.accent
                                    : C.text,
                                flex: 1,
                              },
                              { numberOfLines: 1 },
                            ]}
                          >
                            {session()?.title || tr('Untitled conversation')}
                          </Text>
                          <If when={session()?.hasUnread}>
                            <Icon name="unread" color={C.accent} />
                          </If>
                        </View>
                        <Text
                          style={[
                            { color: C.muted, fontSize: 12, lineHeight: 16 },
                            { numberOfLines: 1 },
                          ]}
                        >
                          {session()?.activity === 'working'
                            ? `${sessionStatusCaption.working} · `
                            : session()?.activity === 'waiting'
                              ? `${sessionStatusCaption.waiting} · `
                              : ''}
                          {/* Forks renamed or titled before the prefix still read as forks. */}
                          {session()?.branch && !hasForkPrefix(session()!.title)
                            ? `${tr('Fork')} · `
                            : ''}
                          {session()?.workspace.path.split('/').filter(Boolean).at(-1) ||
                            session()?.workspace.path}
                        </Text>
                      </Button>
                      <Button
                        ref={(node) => {
                          actionTrigger = node;
                        }}
                        accessibilityLabel={tr('Actions for {title}', {
                          title: session()?.title || tr('Untitled conversation'),
                        })}
                        disabled={props.switching() || !session()}
                        onPress={
                          session()
                            ? inputAction(showActions, {
                                session: sessionActionTarget(session()!),
                                origin: props.selected(),
                              })
                            : undefined
                        }
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
                        focusStyle={platform.isTerminal ? controlFocusStyle() : { opacity: 1 }}
                      >
                        <Icon name="more" color={C.muted} />
                      </Button>
                    </View>
                  </View>
                </View>
              );
            }}
          </Each>
        )}
      </List>
      <If when={browser.loading()}>
        <Text style={{ color: C.muted }}>{tr('Loading…')}</Text>
      </If>
      <If when={navigationNotice()}>
        <Text
          style={[
            { color: navigationNotice()?.kind === 'action' ? C.danger : C.warning },
            { userSelect: 'text' },
          ]}
        >
          {renderText(navigationNotice()?.message ?? '')}
        </Text>
        <If when={navigationNotice()?.kind === 'draft'}>
          <Button
            onPress={inputAction(props.close, null)}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ color: C.accent }}>{tr('Return to draft')}</Text>
          </Button>
        </If>
      </If>
      <If when={browser.error() || browser.projectError()}>
        <Text style={[{ color: C.danger }, { userSelect: 'text' }]}>
          {browser.error() || browser.projectError()}
        </Text>
        <Button
          onPress={inputAction(refresh, null)}
          style={controlStyle}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Text style={{ color: C.accent }}>{tr('Refresh browser')}</Text>
        </Button>
      </If>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingTop: 8,
          borderTopWidth: 1,
          borderTopColor: C.line,
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
          focusStyle={{ backgroundColor: C.line }}
        >
          <Icon name="settings" color={C.secondary} />
          <Text style={{ color: C.secondary }}>{tr('Settings')}</Text>
        </Button>
      </View>
      <Each of={actions() ? [actions()!] : []} key={(target) => target}>
        {(item) => {
          const target = item();
          return (
            <SessionActions
              session={target.session}
              anchor={actionsAnchor}
              current={() => alive && actions() === target && props.selected() === target.origin}
              close={closeActions}
              notice={(message) => navigationNotice.set({ kind: 'action', message })}
              change={(action) => props.changeSession(action, target.origin)}
            />
          );
        }}
      </Each>
    </View>
  );
}

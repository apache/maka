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

import {
  cleanup,
  computed,
  inputAction,
  List,
  Scroll,
  signal,
  Text,
  View,
  type ViewRef,
  type JSX,
} from 'nsh';
import { Button } from 'nsh/base';
import type { AgentSession, AgentSessionPage } from '../../../../packages/plugin-sdk/src/index.js';
import { useHost } from './host';
import { tr } from './locale';
import { errorText, renderText, UiError, type UiText } from './text';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { sessionStatusCaption } from './sessionStatus';
import type { SessionActionTarget } from './sessionLifecycle';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  textTooltip,
} from './ui';

type TreeSession = SessionActionTarget & Partial<Pick<AgentSession, 'activity'>>;
export type TreeActions = {
  session: SessionActionTarget;
  anchor(): ViewRef | null;
  run(operation: () => Promise<void>): Promise<void>;
  current(): boolean;
  close(): void;
};
type Branch = {
  page: AgentSessionPage | null;
  loading: boolean;
  refreshing: boolean;
  error: UiText;
};
type Row = { key: string; depth: number } & (
  | { kind: 'session'; session: TreeSession; parentId: string | null }
  | { kind: 'branch'; parent: TreeSession }
);

function actionTarget(session: TreeSession): SessionActionTarget {
  return {
    id: session.id,
    revision: session.revision,
    title: session.title,
    labels: [...session.labels],
    archived: session.archived,
    pinned: session.pinned,
    workspace: { path: session.workspace.path },
  };
}

export function SessionTree(props: {
  session: SessionActionTarget;
  current(): boolean;
  close(): void;
  openSession(id: string): void;
  renderActions(target: TreeActions): JSX.Element;
}) {
  const host = useHost();
  const actions = signal<TreeActions | null>(null);
  const busy = signal(false);
  const branches = signal<ReadonlyMap<string, Branch>>(new Map());
  const expanded = signal<ReadonlySet<string>>(new Set([props.session.id]));
  const viewportWidth = signal(0);
  const requests = new Map<string, number>();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const active = () => alive && props.current();
  const interactive = () => active() && !busy();
  const update = (id: string, branch: Branch) => branches.set(new Map(branches()).set(id, branch));
  const load = async (id: string, restart = false) => {
    const previous = branches().get(id);
    if (!active() || (!restart && (previous?.loading || previous?.refreshing))) return;
    const request = (requests.get(id) ?? 0) + 1;
    requests.set(id, request);
    const displayed = previous?.page ?? null;
    const page = restart ? null : displayed;
    const quiet = restart && Boolean(displayed?.sessions.length);
    update(id, { page: displayed, loading: !quiet, refreshing: quiet, error: '' });
    try {
      const next = await host.query('agent', 'list', {
        filter: 'all',
        includeArchived: true,
        scope: { kind: 'children', sessionId: id },
        position: page?.after
          ? { kind: 'after', revision: page.revision, cursor: page.after }
          : { kind: 'start' },
      });
      if (!active() || requests.get(id) !== request) return;
      if (page && next.revision !== page.revision)
        throw new UiError('The conversation list changed. Refresh to continue.');
      update(id, {
        page: page ? { ...next, sessions: [...page.sessions, ...next.sessions] } : next,
        loading: false,
        refreshing: false,
        error: '',
      });
    } catch (reason) {
      if (active() && requests.get(id) === request)
        update(id, {
          page: displayed,
          loading: false,
          refreshing: false,
          error: errorText(reason, 'Could not load related conversations.'),
        });
    }
  };
  const toggle = (id: string) => {
    if (!interactive()) return;
    const next = new Set(expanded());
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      if (!branches().has(id)) void load(id);
    }
    expanded.set(next);
  };
  const open = (id: string) => {
    if (interactive()) props.openSession(id);
  };
  const close = () => {
    if (interactive()) props.close();
  };
  const tree = computed(() => {
    const keys: string[] = [];
    const rowsByKey = new Map<string, Row>();
    let maxDepth = 0;
    const stack: Row[] = [
      { kind: 'session', key: props.session.id, depth: 0, session: props.session, parentId: null },
    ];
    while (stack.length) {
      const row = stack.pop()!;
      keys.push(row.key);
      rowsByKey.set(row.key, row);
      maxDepth = Math.max(maxDepth, row.depth);
      if (row.kind !== 'session' || !expanded().has(row.session.id)) continue;
      const branch = branches().get(row.session.id);
      if (!branch) continue;
      if (
        branch.loading ||
        renderText(branch.error) ||
        !branch.page?.sessions.length ||
        branch.page.after
      )
        stack.push({
          kind: 'branch',
          key: `children:${row.session.id}`,
          depth: row.depth + 1,
          parent: row.session,
        });
      const children = branch.page?.sessions ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1)
        stack.push({
          kind: 'session',
          key: children[index]!.id,
          depth: row.depth + 1,
          session: children[index]!,
          parentId: row.session.id,
        });
    }
    return { keys, rowsByKey, maxDepth };
  });
  const contentWidth = () => Math.max(viewportWidth(), 320 + tree().maxDepth * 16);
  void load(props.session.id);
  return (
    <ModalDialog
      size="editor"
      height={640}
      onCancel={close}
      outside={
        // Create menus inside the tree's modal scope.
        <Each of={actions() ? [actions()!] : []} key={(target) => target}>
          {(item) => props.renderActions(item())}
        </Each>
      }
    >
      <DialogHeader title={tr('Child conversations')} />
      <Scroll
        horizontal
        onLayout={({ bounds }) => viewportWidth.set(bounds.size.width)}
        style={{ flex: 1, minHeight: 0 }}
      >
        <List
          each={tree().keys}
          keyExtractor={(key) => key}
          estimatedItemSize={48}
          role="tree"
          accessibilityLabel={tr('Child conversations')}
          style={{ width: contentWidth(), height: '100%', flex: 1, minHeight: 0 }}
        >
          {(item) => (
            <Each of={[item()]} key={(key) => key}>
              {(key) => {
                let last = tree().rowsByKey.get(key())!;
                const currentRow = () => {
                  const next = tree().rowsByKey.get(key());
                  if (next) last = next;
                  return last;
                };
                const initial = currentRow();
                if (initial.kind === 'branch') {
                  const parent = () => (currentRow() as Extract<Row, { kind: 'branch' }>).parent;
                  const branch = () => branches().get(parent().id)!;
                  return (
                    <View
                      style={{
                        minHeight: 48,
                        paddingLeft: initial.depth * 16 + 32,
                        paddingRight: 8,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <If when={branch().loading}>
                        <LoadingIndicator />
                        <Text style={{ ...captionTextStyle, color: C.muted }}>
                          {tr('Loading…')}
                        </Text>
                      </If>
                      <If when={!branch().loading && renderText(branch().error)}>
                        <Text style={{ ...captionTextStyle, flex: 1, color: C.danger }}>
                          {renderText(branch().error)}
                        </Text>
                        <Button
                          accessibilityLabel={tr('Refresh children of {name}', {
                            name: parent().title,
                          })}
                          disabled={!interactive()}
                          onPress={inputAction(() => load(parent().id, true), null)}
                          style={controlStyle}
                          hoverStyle={controlHoverStyle()}
                          focusStyle={controlFocusStyle()}
                          disabledStyle={controlDisabledStyle}
                        >
                          <Text style={{ color: C.text }}>{tr('Refresh')}</Text>
                        </Button>
                      </If>
                      <If when={!branch().loading && !renderText(branch().error)}>
                        <If
                          when={branch().page?.after}
                          else={
                            <Text style={{ ...captionTextStyle, color: C.muted }}>
                              {tr('No child conversations.')}
                            </Text>
                          }
                        >
                          <Button
                            accessibilityLabel={tr('Load more children of {name}', {
                              name: parent().title,
                            })}
                            disabled={!interactive()}
                            onPress={inputAction(() => load(parent().id), null)}
                            style={controlStyle}
                            hoverStyle={controlHoverStyle()}
                            focusStyle={controlFocusStyle()}
                            disabledStyle={controlDisabledStyle}
                          >
                            <Text style={{ color: C.text }}>{tr('Load more')}</Text>
                          </Button>
                        </If>
                      </If>
                    </View>
                  );
                }
                const session = () => (currentRow() as Extract<Row, { kind: 'session' }>).session;
                const present = () => tree().rowsByKey.has(key());
                const actionTrigger = signal<ViewRef | null>(null);
                cleanup(() => {
                  actionTrigger.set(null);
                });
                const showActions = (target: SessionActionTarget) => {
                  const current = session();
                  if (
                    !interactive() ||
                    !present() ||
                    !actionTrigger() ||
                    current.id !== target.id ||
                    current.revision !== target.revision
                  )
                    return;
                  const menu: TreeActions = {
                    session: target,
                    anchor: actionTrigger,
                    run: async (operation) => {
                      busy.set(true);
                      try {
                        await operation();
                        if (initial.parentId === null) {
                          if (active()) props.close();
                        } else {
                          await load(initial.parentId, true);
                          if (alive && actions() === menu) actions.set(null);
                        }
                      } finally {
                        if (alive) busy.set(false);
                      }
                    },
                    current: () => active() && actions() === menu,
                    close: () => {
                      if (actions() === menu) actions.set(null);
                    },
                  };
                  actions.set(menu);
                };
                const branch = () => branches().get(session().id);
                const leaf = () => branch()?.page?.sessions.length === 0 && !branch()?.page?.after;
                const caption = () => {
                  const current = session();
                  return [
                    current.archived
                      ? tr('Archived')
                      : current.activity && current.activity !== 'idle'
                        ? sessionStatusCaption[current.activity]
                        : '',
                    current.workspace?.path ?? '',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                };
                return (
                  <View
                    role="treeitem"
                    onContextMenu={
                      interactive() && present()
                        ? inputAction(showActions, actionTarget(session()))
                        : undefined
                    }
                    accessibilityLevel={initial.depth + 1}
                    accessibilityLabel={session().title}
                    accessibilityState={{
                      expanded: leaf() ? undefined : expanded().has(session().id),
                    }}
                    style={{
                      height: 48,
                      paddingLeft: initial.depth * 16,
                      flexDirection: 'row',
                      alignItems: 'center',
                    }}
                  >
                    <If when={!leaf()} else={<View style={{ width: 32 }} />}>
                      <Button
                        accessibilityLabel={tr(
                          expanded().has(session().id) ? 'Collapse {name}' : 'Expand {name}',
                          { name: session().title },
                        )}
                        disabled={!interactive() || !present()}
                        onPress={inputAction(toggle, session().id)}
                        style={{
                          ...controlStyle,
                          width: 32,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        hoverStyle={controlHoverStyle()}
                        focusStyle={controlFocusStyle()}
                        disabledStyle={controlDisabledStyle}
                      >
                        <Icon
                          name={expanded().has(session().id) ? 'down' : 'right'}
                          color={C.muted}
                        />
                      </Button>
                    </If>
                    <Button
                      role="link"
                      accessibilityLabel={tr('Open {name}', { name: session().title })}
                      tooltip={textTooltip(() => session().title)}
                      disabled={!interactive() || !present()}
                      onPress={inputAction(open, session().id)}
                      style={{
                        ...controlStyle,
                        flex: 1,
                        minWidth: 0,
                        height: 48,
                        paddingHorizontal: 8,
                        justifyContent: 'center',
                      }}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                      disabledStyle={controlDisabledStyle}
                    >
                      <Text style={[{ ...bodyTextStyle, color: C.text }, { numberOfLines: 1 }]}>
                        {session().title}
                      </Text>
                      <If when={caption()}>
                        <Text
                          style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}
                        >
                          {caption()}
                        </Text>
                      </If>
                    </Button>
                    <Button
                      ref={(node) => {
                        actionTrigger.set(node);
                      }}
                      accessibilityLabel={tr('Actions for {title}', { title: session().title })}
                      tooltip={textTooltip(() => tr('Conversation actions'))}
                      disabled={!interactive() || !present()}
                      onPress={inputAction(showActions, actionTarget(session()))}
                      style={{
                        ...controlStyle,
                        width: 32,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                      disabledStyle={controlDisabledStyle}
                    >
                      <Icon name="more" color={C.muted} />
                    </Button>
                  </View>
                );
              }}
            </Each>
          )}
        </List>
      </Scroll>
      <DialogFooter>
        <SettingsButton
          label={tr('Close')}
          accessibilityLabel={tr('Close child conversations')}
          disabled={!interactive()}
          onPress={close}
        />
      </DialogFooter>
    </ModalDialog>
  );
}

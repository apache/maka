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

import { cleanup, computed, inputAction, List, Scroll, signal, Text, View } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import type { AgentSession, AgentSessionPage } from '../../../../packages/plugin-sdk/src/index.js';
import { useHost } from './host';
import { tr } from './locale';
import { errorText, renderText, UiError, type UiText } from './text';
import { dialogTop } from './chrome';
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

type TreeSession = Pick<AgentSession, 'id' | 'title' | 'archived'> &
  Partial<Pick<AgentSession, 'activity'>> & { workspace?: Pick<AgentSession['workspace'], 'path'> };
type Branch = { page: AgentSessionPage | null; loading: boolean; error: UiText };
type Row = { key: string; depth: number } & (
  | { kind: 'session'; session: TreeSession }
  | { kind: 'branch'; parent: TreeSession }
);

export function SessionTree(props: {
  session: SessionActionTarget;
  current(): boolean;
  close(): void;
  openSession(id: string): void;
}) {
  const host = useHost();
  const branches = signal<ReadonlyMap<string, Branch>>(new Map());
  const expanded = signal<ReadonlySet<string>>(new Set([props.session.id]));
  const viewportWidth = signal(0);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const active = () => alive && props.current();
  const update = (id: string, branch: Branch) => branches.set(new Map(branches()).set(id, branch));
  const load = async (id: string, restart = false) => {
    const previous = branches().get(id);
    if (!active() || previous?.loading) return;
    const page = restart ? null : (previous?.page ?? null);
    update(id, { page, loading: true, error: '' });
    try {
      const next = await host.query('agent', 'list', {
        filter: 'all',
        includeArchived: true,
        scope: { kind: 'children', sessionId: id },
        position: page?.after
          ? { kind: 'after', revision: page.revision, cursor: page.after }
          : { kind: 'start' },
      });
      if (!active()) return;
      if (page && next.revision !== page.revision)
        throw new UiError('The conversation list changed. Refresh to continue.');
      update(id, {
        page: page ? { ...next, sessions: [...page.sessions, ...next.sessions] } : next,
        loading: false,
        error: '',
      });
    } catch (reason) {
      if (active()) update(id, { page, loading: false, error: errorText(reason) });
    }
  };
  const toggle = (id: string) => {
    if (!active()) return;
    const next = new Set(expanded());
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      if (!branches().has(id)) void load(id);
    }
    expanded.set(next);
  };
  const open = (id: string) => {
    if (active()) props.openSession(id);
  };
  const close = () => {
    if (active()) props.close();
  };
  const rows = computed(() => {
    const rows: Row[] = [];
    const stack: Row[] = [
      { kind: 'session', key: props.session.id, depth: 0, session: props.session },
    ];
    while (stack.length) {
      const row = stack.pop()!;
      rows.push(row);
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
        });
    }
    return rows;
  });
  const contentWidth = () =>
    Math.max(
      viewportWidth(),
      320 + rows().reduce((depth, row) => Math.max(depth, row.depth), 0) * 16,
    );
  void load(props.session.id);
  return (
    <Dialog
      animation="none"
      onCancel={close}
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
        paddingTop: dialogTop(16),
        backgroundColor: C.scrim,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 720,
          height: '100%',
          maxHeight: 640,
          minHeight: 0,
          padding: 16,
          gap: 12,
          backgroundColor: C.surface,
          borderRadius: 16,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text
            role="header"
            style={{ ...bodyTextStyle, flex: 1, color: C.text, fontWeight: '600' }}
          >
            {tr('Child conversations')}
          </Text>
          <Button
            accessibilityLabel={tr('Close child conversations')}
            tooltip={textTooltip(() => tr('Close'))}
            onPress={inputAction(close, null)}
            style={{ ...controlStyle, width: 32, alignItems: 'center', justifyContent: 'center' }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Icon name="close" color={C.secondary} />
          </Button>
        </View>
        <Scroll
          horizontal
          onLayout={({ bounds }) => viewportWidth.set(bounds.size.width)}
          style={{ flex: 1, minHeight: 0 }}
        >
          <List
            each={rows()}
            keyExtractor={(row) => row.key}
            estimatedItemSize={48}
            role="tree"
            accessibilityLabel={tr('Child conversations')}
            style={{ width: contentWidth(), flex: 1, minHeight: 0 }}
          >
            {(item) => (
              <Each of={[item()]} key={(row) => row.key}>
                {(value) => {
                  const row = value();
                  if (row.kind === 'branch') {
                    const branch = () => branches().get(row.parent.id)!;
                    return (
                      <View
                        style={{
                          minHeight: 48,
                          paddingLeft: row.depth * 16 + 32,
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
                              name: row.parent.title,
                            })}
                            onPress={inputAction(() => load(row.parent.id, true), null)}
                            style={controlStyle}
                            hoverStyle={controlHoverStyle()}
                            focusStyle={controlFocusStyle()}
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
                                name: row.parent.title,
                              })}
                              onPress={inputAction(() => load(row.parent.id), null)}
                              style={controlStyle}
                              hoverStyle={controlHoverStyle()}
                              focusStyle={controlFocusStyle()}
                            >
                              <Text style={{ color: C.text }}>{tr('Load more')}</Text>
                            </Button>
                          </If>
                        </If>
                      </View>
                    );
                  }
                  const session = () => (value() as Extract<Row, { kind: 'session' }>).session;
                  const branch = () => branches().get(session().id);
                  const leaf = () =>
                    branch()?.page?.sessions.length === 0 && !branch()?.page?.after;
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
                      accessibilityLevel={row.depth + 1}
                      accessibilityLabel={session().title}
                      accessibilityState={{
                        expanded: leaf() ? undefined : expanded().has(session().id),
                      }}
                      style={{
                        height: 48,
                        paddingLeft: row.depth * 16,
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
                          onPress={inputAction(toggle, session().id)}
                          style={{
                            ...controlStyle,
                            width: 32,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                          hoverStyle={controlHoverStyle()}
                          focusStyle={controlFocusStyle()}
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
                        disabled={!active()}
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
                    </View>
                  );
                }}
              </Each>
            )}
          </List>
        </Scroll>
      </View>
    </Dialog>
  );
}

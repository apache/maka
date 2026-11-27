/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { computed, effect, Scroll, signal, type Signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { Cursor, HistoryPosition } from '../../../../packages/plugin-sdk/src/index.js';
import type { WorkerSession } from './discoveryDossiersCore';
import { DialogHeader, DialogFooter, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { ToolCard } from './ToolCard';
import { useHost } from './host';
import { mergeHistoryPage, type Row } from './history';
import { tr } from './locale';
import { sessionStatusCaption } from './sessionStatus';
import { createText, errorText, UiError } from './text';
import {
  C,
  captionTextStyle,
  controlHoverStyle,
  Disclosure,
  quietFocusStyle,
  secondaryTextStyle,
} from './ui';

export function ProbeIndicator() {
  return (
    <View
      accessibilityLabel={tr('Discovery probe running')}
      style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.success }}
    />
  );
}

export function DiscoveryRuns(props: {
  runs(): readonly WorkerSession[];
  initialRunId?: string | null;
  time(at: number): string;
  close(): void;
}) {
  const host = useHost();
  const selected = signal<string | null>(props.initialRunId ?? null);
  const run = computed(() => props.runs().find((r) => r.id === selected()));
  const observedTitle = signal<string | null>(null);
  const position = signal<HistoryPosition>({ kind: 'tail' });
  const earlier = signal<Cursor | null>(null);
  const later = signal<Cursor | null>(null);
  const fence = signal<number | null>(null);
  const rows = signal<Row[] | null>(null);
  const refreshTick = signal(0);
  const error = createText();
  const toolStates = new Map<string, { expanded: Signal<boolean>; original: Signal<boolean> }>();
  const instructionStates = new Map<string, Signal<boolean>>();
  const toolState = (key: string) => {
    let state = toolStates.get(key);
    if (!state) {
      state = { expanded: signal(false), original: signal(false) };
      toolStates.set(key, state);
    }
    return state;
  };
  const instructionOpen = (key: string) => {
    let state = instructionStates.get(key);
    if (!state) {
      state = signal(false);
      instructionStates.set(key, state);
    }
    return state;
  };

  let lastRouteKey: string | null = null;
  let loadedId: string | null = null;
  let loadedPageKey = '';

  effect(() => {
    const initial = props.initialRunId ?? null;
    if (initial && initial !== selected()) {
      position.set({ kind: 'tail' });
      selected.set(initial);
    }
  });

  effect(() => {
    const id = selected();
    observedTitle.set(null);
    if (!id || props.runs().some((r) => r.id === id)) return;
    let active = true;
    void host
      .query('agent', 'observe', { sessionId: id })
      .then((observed) => {
        if (active && observed?.session?.title) observedTitle.set(observed.session.title);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  });

  effect(() => {
    const id = selected();
    const pageAt = position();
    const refresh = refreshTick();
    const pageKey = JSON.stringify(pageAt);
    const routeKey = id ? `${id}:${pageKey}` : null;
    const isQuietReload = routeKey !== null && routeKey === lastRouteKey && refresh > 0;
    lastRouteKey = routeKey;
    if (id !== loadedId) {
      loadedId = id;
      toolStates.clear();
      instructionStates.clear();
    }
    if (!isQuietReload) {
      loadedPageKey = pageKey;
      rows.set(null);
      if (id == null || pageAt.kind === 'tail') {
        earlier.set(null);
        later.set(null);
        fence.set(null);
      }
    } else if (loadedPageKey !== pageKey) {
      loadedPageKey = pageKey;
    }
    error.set('');
    if (!id) return;
    const through = pageAt.kind === 'tail' ? null : fence();
    let active = true;
    void host
      .query('agent', 'history', {
        sessionId: id,
        position: pageAt,
        through,
        view: 'conversation',
        includeThinking: false,
      })
      .then((page) => {
        if (!active) return;
        if (page.kind !== 'ready') throw new UiError('Could not load conversation history.');
        earlier.set(page.before);
        later.set(page.after);
        fence.set(page.through);
        rows.set(
          mergeHistoryPage(page.chunks, () => undefined, false, page.through).filter((r) =>
            Boolean(r.text.trim() || r.tool?.call),
          ),
        );
      })
      .catch((cause) => {
        if (active) error.set(errorText(cause, 'Could not load conversation history.'));
      });
    return () => {
      active = false;
    };
  });

  effect(() => {
    const id = selected();
    const activeRun = run();
    const atTail = position().kind === 'tail';
    if (!id || !atTail || !activeRun || activeRun.activity === 'idle') return;
    const timer = setInterval(() => {
      refreshTick.set(refreshTick() + 1);
    }, 3000);
    return () => clearInterval(timer);
  });

  const openLink = async (target: string) => {
    if (/^https?:\/\//i.test(target)) {
      await host.openBrowser?.(target);
    }
  };

  const caption = (r: WorkerSession) => {
    const terminal = r.discoveryRun?.terminal;
    const status = terminal
      ? tr(({ completed: 'Completed', cancelled: 'Stopped', failed: 'Failed' } as const)[terminal])
      : sessionStatusCaption[r.activity];
    const started = r.discoveryRun?.startedAt;
    const at =
      started != null && props.time(started) !== props.time(r.updatedAt)
        ? props.time(started) + ' – ' + props.time(r.updatedAt)
        : props.time(r.updatedAt);
    return status + ' · ' + at;
  };

  const headerTitle = () => run()?.title ?? observedTitle() ?? tr('Discovery runs');
  const headerDetail = () => {
    const current = run();
    if (current) return caption(current);
    return '';
  };

  return (
    <ModalDialog size="editor" height={520} onCancel={props.close}>
      <DialogHeader title={headerTitle()} detail={headerDetail()} />
      <Scroll style={{ flex: 1 }}>
        <If
          when={!selected()}
          else={
            <>
              <If when={error()}>
                <Text style={{ color: C.danger }}>{error()}</Text>
              </If>
              <If when={rows() === null && !error()}>
                <Text style={{ color: C.muted }}>{tr('Loading…')}</Text>
              </If>
              <If when={rows()?.length === 0}>
                <Text style={{ color: C.muted }}>{tr('No output recorded.')}</Text>
              </If>
              <Each of={rows() ?? []} key={(r) => r.key}>
                {(r) => {
                  const row = r();
                  if (row.tool?.call) {
                    return (
                      <View style={{ gap: 2, paddingVertical: 4 }}>
                        <If when={row.timestamp != null}>
                          <Text style={{ ...captionTextStyle, color: C.muted }}>
                            {props.time(row.timestamp!)}
                          </Text>
                        </If>
                        <ToolCard
                          row={r}
                          sessionId={selected()!}
                          ownerKey={() => r().key}
                          through={() => fence() ?? 0}
                          expanded={() => toolState(r().key).expanded()}
                          original={() => toolState(r().key).original()}
                          maxHeight={() => 320}
                          expand={({ key, value }) => toolState(key).expanded.set(value)}
                          showOriginal={({ key, value }) => toolState(key).original.set(value)}
                          openLink={openLink}
                          previewImage={() => {}}
                          userScroll={() => {}}
                        />
                      </View>
                    );
                  }
                  if (row.role === 'user') {
                    const expanded = instructionOpen(row.key);
                    return (
                      <View style={{ gap: 4, paddingVertical: 4 }}>
                        <Disclosure
                          label={tr('Discovery instructions')}
                          open={expanded()}
                          onPress={() => expanded.set(!expanded())}
                          trailing={
                            <If when={row.timestamp != null}>
                              <Text style={{ ...captionTextStyle, color: C.muted }}>
                                {props.time(row.timestamp!)}
                              </Text>
                            </If>
                          }
                        >
                          <Text style={{ ...captionTextStyle, color: C.secondary }}>
                            {tr('Discovery instructions')}
                          </Text>
                        </Disclosure>
                        <If when={expanded()}>
                          <Text
                            style={{ ...captionTextStyle, color: C.secondary, userSelect: 'text' }}
                          >
                            {row.text}
                          </Text>
                        </If>
                      </View>
                    );
                  }
                  return (
                    <View style={{ gap: 3, paddingVertical: 6 }}>
                      <If when={row.timestamp != null}>
                        <Text style={{ ...captionTextStyle, color: C.muted }}>
                          {props.time(row.timestamp!)}
                        </Text>
                      </If>
                      <Text style={{ ...secondaryTextStyle, color: C.text, userSelect: 'text' }}>
                        {row.text}
                      </Text>
                    </View>
                  );
                }}
              </Each>
            </>
          }
        >
          <If when={!props.runs().length}>
            <Text style={{ ...secondaryTextStyle, color: C.muted }}>
              {tr('No discovery runs yet.')}
            </Text>
          </If>
          <Each of={props.runs()} key={(r) => r.id}>
            {(r) => (
              <Button
                onPress={() => {
                  position.set({ kind: 'tail' });
                  selected.set(r().id);
                }}
                accessibilityLabel={r().title}
                style={{ padding: 8, gap: 3, borderRadius: 6 }}
                hoverStyle={controlHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <If when={r().activity !== 'idle'}>
                    <ProbeIndicator />
                  </If>
                  <Text style={{ ...secondaryTextStyle, color: C.text, flexShrink: 1 }}>
                    {r().title}
                  </Text>
                </View>
                <Text style={{ ...captionTextStyle, color: C.muted }}>{caption(r())}</Text>
              </Button>
            )}
          </Each>
        </If>
      </Scroll>
      <DialogFooter>
        <If when={selected() && rows() && earlier()}>
          <SettingsButton
            label={tr('Previous page')}
            onPress={() => position.set({ kind: 'before', cursor: earlier()! })}
          />
        </If>
        <If when={selected() && rows() && later()}>
          <SettingsButton
            label={tr('Next page')}
            onPress={() => position.set({ kind: 'after', cursor: later()! })}
          />
        </If>
        <If when={selected()}>
          <SettingsButton
            label={tr('Refresh')}
            onPress={() => refreshTick.set(refreshTick() + 1)}
          />
        </If>
        <If when={selected()}>
          <SettingsButton label={tr('Back')} onPress={() => selected.set(null)} />
        </If>
        <SettingsButton
          label={tr('Close')}
          accessibilityLabel={tr('Close {name}', { name: tr('Discovery runs') })}
          onPress={props.close}
        />
      </DialogFooter>
    </ModalDialog>
  );
}

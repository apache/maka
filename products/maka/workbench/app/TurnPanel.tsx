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

import { createText, errorText } from './text';
import { displayText, tr } from './locale';
import { cleanup, computed, effect, inputAction, signal, Text, View, List } from 'nsh';
import type { ListRef, Signal, ViewRef } from 'nsh';
import type { AnimatedValue } from 'nsh';
import { platform, windowSize } from 'nsh';
import type { Row } from './history';
import { MessageRow, type MessageViewState } from './MessageRow';
import type { ProcessGroup, TurnPresentation } from './processGroups';
import { C, captionTextStyle, controlStyle, Disclosure, disclosureTitleStyle } from './ui';
import type { ImagePreview } from './ToolImage';
import { toolActivitySummary, type ToolActivity } from './toolActivity';

const panelStyle = {
  marginVertical: 8,
  gap: 8,
  padding: 0,
  borderWidth: 0,
};
const groupHeaderHeight = Math.max(
  controlStyle.minHeight,
  captionTextStyle.lineHeight + 2 * controlStyle.paddingVertical,
);
const memberGap = 6;

export type LiveActivity = {
  kind: 'working' | 'thinking' | 'response' | 'waiting';
  detail: string;
  rowId?: string;
};
export type TurnViewState = {
  expanded: Signal<{ open: boolean; answerKey: string | undefined } | null>;
};
export type GroupViewState = {
  open: Signal<boolean>;
  following: Signal<boolean>;
  offset: AnimatedValue;
  measured: Map<string, { width: number; height: number }>;
  lease: number;
  opening?: 'top' | 'bottom';
  revealRow?: string;
  visibleRows: Signal<ReadonlySet<string>>;
  rowNodes: Map<string, ViewRef>;
  list?: ListRef;
  requestFocus?: boolean;
};

export function turnOutcome(turn: TurnPresentation): string | null {
  return turn.finalOutputIds.length > 0 ? 'completed' : (turn.timing?.finished?.outcome ?? null);
}

function duration(turn: TurnPresentation, now?: number): string {
  const start = turn.timing?.startedAt;
  const end = turn.timing?.finished?.at ?? now;
  if (start == null || end == null || end < start) return '';
  const seconds = Math.floor((end - start) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function TurnSummary(props: {
  turn: () => TurnPresentation;
  expanded: () => boolean;
  canFold: () => boolean;
  toggle(open: boolean): void;
}) {
  const label = () => {
    const outcome = turnOutcome(props.turn());
    return outcome === 'completed'
      ? tr('Completed')
      : outcome === 'failed'
        ? tr('Failed')
        : outcome === 'aborted'
          ? tr('Stopped')
          : tr('Activity');
  };
  const choose = (action: { turnId: string; answerKey: string | undefined; open: boolean }) => {
    const turn = props.turn();
    if (turn.turnId === action.turnId && turn.answerKey === action.answerKey && props.canFold())
      props.toggle(action.open);
  };
  return (
    <View style={{ marginTop: 8, marginBottom: platform.isTerminal ? 0 : 8 }}>
      <Disclosure
        label={tr('Turn work details')}
        open={props.expanded()}
        foldable={props.canFold()}
        terminalInset={controlStyle.paddingHorizontal}
        onPress={inputAction(choose, {
          turnId: props.turn().turnId,
          answerKey: props.turn().answerKey,
          open: !props.expanded(),
        })}
      >
        <Text
          style={[
            {
              ...disclosureTitleStyle,
              color: turnOutcome(props.turn()) === 'failed' ? C.danger : C.muted,
            },
            { numberOfLines: 1 },
          ]}
        >
          {label()}
        </Text>
        <If when={turnOutcome(props.turn()) === 'completed'}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{duration(props.turn())}</Text>
        </If>
      </Disclosure>
    </View>
  );
}

function stableActivityTitle(desiredTitle: () => string, active: () => boolean) {
  let presentedTitle = desiredTitle();
  let presentedAt = Date.now();
  const stableTitle = signal(presentedTitle);
  effect(() => {
    const desired = desiredTitle();
    if (desired === presentedTitle) return;
    const remaining = active() ? 150 - (Date.now() - presentedAt) : 0;
    const commit = () => {
      presentedTitle = desiredTitle();
      presentedAt = Date.now();
      stableTitle.set(presentedTitle);
    };
    if (remaining <= 0) commit();
    else {
      const timer = setTimeout(commit, remaining);
      cleanup(() => clearTimeout(timer));
    }
  });
  return stableTitle;
}

function ActivityLog(props: {
  group: () => ProcessGroup;
  row(id: string): Row | undefined;
  rowState(id: string): MessageViewState;
  state: GroupViewState;
  sessionId: string;
  through: () => number;
  viewport: () => { width: number; height: number };
  previewImage(image: ImagePreview): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
  reading(away: boolean): void;
  reveal(): void;
}) {
  const state = props.state;
  const lease = ++state.lease;
  const initial = signal<{ y: number } | null>(null);
  const measurements = signal(0);
  const error = createText();
  // Reveal a user-opened source after its native height changes, so the outer
  // List positions the grown group rather than its old one-line body.
  const pendingReveal = signal<{ rowId: string; height: number } | null>(null);
  effect(() => {
    const pending = pendingReveal();
    if (
      pending &&
      (!props.group().rowIds.includes(pending.rowId) || !props.rowState(pending.rowId).expanded())
    )
      pendingReveal.set(null);
  });
  const opening = state.opening;
  state.opening = undefined;
  let ownList: ListRef | undefined;
  let alive = true;
  cleanup(() => {
    alive = false;
    pendingReveal.set(null);
    if (state.list === ownList) {
      state.list = undefined;
      state.visibleRows.set(new Set());
    }
  });
  // Native cell measurements fit short groups. Unmeasured cells start at the
  // one-line row minimum; text length never acts as a layout authority.
  const bodyMaxHeight = () => {
    const chrome =
      groupHeaderHeight +
      panelStyle.gap +
      2 * (panelStyle.marginVertical + panelStyle.padding + panelStyle.borderWidth);
    const viewportHeight = props.viewport().height;
    const available = Math.max(16, Math.min(400, windowSize().height / 2, viewportHeight - chrome));
    return platform.isTerminal ? Math.floor(available / 16) * 16 : available;
  };
  const bodyHeight = () => {
    measurements();
    const viewport = props.viewport();
    const measured = props.group().rowIds.reduce((height, id) => {
      const row = state.measured.get(id);
      return (
        height +
        (row?.width === viewport.width
          ? row.height
          : controlStyle.minHeight + (id === props.group().rowIds.at(-1) ? 0 : memberGap))
      );
    }, 0);
    return Math.min(bodyMaxHeight(), Math.max(16, measured));
  };
  // Read before binding: the new List's first layout writes its scroll gauge.
  if (opening) initial.set({ y: 0 });
  else
    void state.offset
      .getValue()
      .then((y) => {
        if (alive && lease === state.lease) {
          // Mount-owned tool loaders read again. Their temporary loading view
          // cannot restore an offset from a previous, much taller source body.
          const reloading = props
            .group()
            .rowIds.some((id) => props.row(id)?.tool && props.rowState(id).expanded());
          if (reloading) state.following.set(false);
          initial.set({ y: reloading ? 0 : y });
        }
      })
      .catch((reason) => {
        if (alive) error.set(errorText(reason));
      });
  return (
    <View style={{ height: bodyHeight() }}>
      <If when={initial()}>
        <List
          accessibilityLabel={tr('Turn activity')}
          each={props.group().rowIds}
          onViewableItemsChange={(event) => {
            if (alive && lease === state.lease)
              state.visibleRows.set(new Set(event.viewableItems.map((item) => item.item)));
          }}
          estimatedItemSize={controlStyle.minHeight + memberGap}
          scrollValue={state.offset}
          contentOffset={initial()!}
          maintainVisibleContentPosition={
            state.following() ? { autoscrollToBottomThreshold: 16 } : {}
          }
          scrollbar={true}
          onScrollIntent={props.userScroll}
          onScroll={(event) => {
            if (!alive || lease !== state.lease) return;
            const away =
              event.offset.y < Math.max(0, event.contentSize.height - event.size.height) - 1;
            // A capped tool reader can be at the turn's bottom while the user
            // is reading its original. Only an explicit return resumes follow.
            if (
              !away &&
              !state.following() &&
              props.group().rowIds.some((id) => {
                const row = props.row(id);
                return (
                  (row?.tool != null || row?.role === 'tool_call' || row?.role === 'tool_result') &&
                  props.rowState(id).expanded() === true
                );
              })
            )
              return;
            state.following.set(!away);
            props.reading(away);
          }}
          contentStyle={{ paddingRight: 8 }}
          ref={(node) => {
            ownList = node;
            state.list = node;
            if (state.revealRow) {
              const index = props.group().rowIds.indexOf(state.revealRow);
              if (index >= 0) node.scrollToIndex({ index, viewPosition: 0, animated: false });
              state.revealRow = undefined;
            } else if (opening === 'bottom') node.scrollToEnd({ animated: false });
            else if (opening === 'top') node.scrollToOffset({ offset: 0, animated: false });
            if (state.requestFocus) {
              state.requestFocus = false;
              node.focus();
            }
          }}
          style={{ height: bodyHeight() }}
        >
          {(id) => (
            <Each of={[id()]} key={(key: string) => key}>
              {(ownedId) => {
                const first = props.row(ownedId());
                if (!first) return <View />;
                const rowId = ownedId();
                let ownRow: ViewRef | undefined;
                cleanup(() => {
                  if (state.rowNodes.get(rowId) === ownRow) state.rowNodes.delete(rowId);
                });
                return (
                  <View
                    ref={(node) => {
                      ownRow = node;
                      state.rowNodes.set(rowId, node);
                    }}
                    style={{
                      paddingBottom: props.group().rowIds.at(-1) === ownedId() ? 0 : memberGap,
                    }}
                    onLayout={({ bounds: frame }) => {
                      if (
                        !alive ||
                        lease !== state.lease ||
                        !props.group().rowIds.includes(ownedId())
                      )
                        return;
                      const width = props.viewport().width;
                      const old = state.measured.get(ownedId());
                      if (
                        frame.size.height > 0 &&
                        (!old || old.width !== width || old.height !== frame.size.height)
                      ) {
                        state.measured.set(ownedId(), { width, height: frame.size.height });
                        measurements.set(measurements() + 1);
                        const pending = pendingReveal();
                        if (
                          pending?.rowId === ownedId() &&
                          frame.size.height > pending.height &&
                          props.rowState(ownedId()).expanded()
                        ) {
                          pendingReveal.set(null);
                          props.reveal();
                        }
                      }
                    }}
                  >
                    <MessageRow
                      item={() => props.row(ownedId()) ?? first}
                      ownerKey={ownedId}
                      viewState={props.rowState(ownedId())}
                      toolMaxHeight={bodyMaxHeight}
                      onToolReading={(key) => {
                        if (
                          !alive ||
                          lease !== state.lease ||
                          key !== ownedId() ||
                          !props.group().rowIds.includes(key) ||
                          !props.rowState(key).expanded()
                        )
                          return;
                        state.following.set(false);
                        props.reading(true);
                      }}
                      sessionId={props.sessionId}
                      through={props.through}
                      previewImage={props.previewImage}
                      openLink={props.openLink}
                      userScroll={props.userScroll}
                      onExpand={(key) => {
                        if (!alive || !ownList) return;
                        state.following.set(false);
                        props.reading(true);
                        const index = props.group().rowIds.indexOf(key);
                        if (index >= 0) {
                          pendingReveal.set({
                            rowId: key,
                            height: state.measured.get(key)?.height ?? 16,
                          });
                          ownList.scrollToIndex({ index, viewPosition: 0, animated: false });
                        }
                      }}
                    />
                  </View>
                );
              }}
            </Each>
          )}
        </List>
      </If>
      <If when={error()}>
        <Text style={{ color: C.danger }}>{error()}</Text>
      </If>
    </View>
  );
}

export function TurnPanel(props: {
  group: () => ProcessGroup;
  turn: () => TurnPresentation;
  toolActivity: () => ToolActivity | undefined;
  state: GroupViewState;
  row(id: string): Row | undefined;
  rowState(id: string): MessageViewState;
  sessionId: string;
  through: () => number;
  viewport: () => { width: number; height: number };
  activity: () => LiveActivity;
  reveal(): void;
  previewImage(image: ImagePreview): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
  reading(away: boolean): void;
}) {
  const active = () =>
    props.turn().active &&
    turnOutcome(props.turn()) === null &&
    (!props.group().closed || props.toolActivity() !== undefined);
  const clock = signal(Date.now());
  const hasDuration = computed(() => active() && props.turn().timing?.startedAt != null);
  effect(() => {
    if (!hasDuration()) return;
    const timer = setInterval(() => clock.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
  });
  const counts = () => {
    const thoughts = props
      .group()
      .rowIds.filter((id) => props.row(id)?.field === 'thinking').length;
    const tools = props.group().toolIds.length;
    return (
      [
        thoughts
          ? tr(thoughts === 1 ? '{count} thought' : '{count} thoughts', { count: thoughts })
          : '',
        tools ? tr(tools === 1 ? '{count} tool' : '{count} tools', { count: tools }) : '',
      ]
        .filter(Boolean)
        .join(' · ') || tr('Process')
    );
  };
  const desiredTitle = computed(() => {
    if (!active()) return counts();
    const activity = props.activity();
    if (activity.kind === 'waiting') return tr('Waiting for your response');
    const tool = props.toolActivity();
    if (tool)
      return toolActivitySummary(
        tool,
        tool.phase === 'preparing' ? tr('Preparing tool') : tr('Running tool'),
        tool.title ? displayText(tool.title) : undefined,
      );
    if (
      activity.kind === 'thinking' &&
      activity.rowId &&
      props.group().rowIds.includes(activity.rowId)
    )
      return `${tr('Analyzing the request')}${activity.detail ? ` · ${activity.detail}` : ''}`;
    return tr('Working…');
  });
  const stableTitle = stableActivityTitle(desiredTitle, active);
  const choose = (action: { sessionId: string; key: string; open: boolean }) => {
    if (
      action.sessionId !== props.sessionId ||
      action.key !== props.group().key ||
      !props.group().rowIds.length
    )
      return;
    if (action.open) {
      props.state.opening = props.group().closed ? 'top' : 'bottom';
      props.state.following.set(!props.group().closed);
    }
    props.reading(action.open && props.group().closed);
    props.state.open.set(action.open);
    if (action.open) props.reveal();
  };
  return (
    <View style={panelStyle}>
      <Disclosure
        label={tr('Process group')}
        open={props.state.open()}
        foldable={props.group().rowIds.length > 0}
        onPress={inputAction(choose, {
          sessionId: props.sessionId,
          key: props.group().key,
          open: !props.state.open(),
        })}
      >
        <Text
          style={[
            { ...disclosureTitleStyle, color: active() ? C.secondary : C.muted },
            { numberOfLines: 1, textOverflow: 'ellipsis' },
          ]}
        >
          {active() ? stableTitle() : desiredTitle()}
        </Text>
        <If when={active()}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {duration(props.turn(), clock())}
          </Text>
        </If>
      </Disclosure>
      <If when={props.state.open() && props.group().rowIds.length > 0}>
        <ActivityLog {...props} />
      </If>
    </View>
  );
}

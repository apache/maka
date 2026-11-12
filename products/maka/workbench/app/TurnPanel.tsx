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

import { formatDuration } from './duration';
import { executorUsageLabel } from './TurnUsage';
import { LoadingIndicator } from './Loading';
import { createText, errorText } from './text';
import { displayText, tr } from './locale';
import { Canvas, cleanup, computed, effect, inputAction, signal, Text, View, List } from 'nsh';
import type { ListRef, Signal, ViewRef } from 'nsh';
import type { AnimatedValue } from 'nsh';
import { platform, windowSize } from 'nsh';
import { senderSession, type Row } from './history';
import { MessageRow, type MessageViewState } from './MessageRow';
import type { MessageSenders } from './messageSenders';
import type { ProcessGroup, TurnPresentation } from './processGroups';
import { turnOutcome } from './processGroups';
import { C, captionTextStyle, controlStyle, Disclosure, disclosureTitleStyle } from './ui';
import { ToolImageStrip, type ImagePreview, type ToolImageRef } from './ToolImage';
import { LiveToolRow } from './ToolCard';
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
const memberGap = platform.idiom === 'terminal' ? 6 : 0;
const activityFollowThreshold = captionTextStyle.lineHeight;
const activityEdgeFadeHeight = 14;

export type LiveActivity = {
  kind: 'working' | 'thinking' | 'response' | 'waiting';
  detail: string;
  rowId?: string;
};
export type TurnViewState = {
  /** The user's own choice to open or fold the turn's work; null until they make one. */
  expanded: Signal<boolean | null>;
  /** Seen running and not yet given its outcome, which arrives a moment after the run ends. */
  ran: boolean;
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

function elapsed(turn: TurnPresentation, now?: number): number | null {
  const start = turn.timing?.startedAt;
  const end = turn.timing?.finished?.at ?? now;
  return start == null || end == null || end < start ? null : end - start;
}

function duration(turn: TurnPresentation, now?: number): string {
  const time = elapsed(turn, now);
  return time === null ? '' : formatDuration(time);
}

/** What a turn's work did, counted over its groups: "2 thoughts · 3 tools". */
export function activityCounts(
  groups: readonly ProcessGroup[],
  row: (id: string) => Row | undefined,
): string {
  const ids = groups.flatMap((group) => group.rowIds);
  const thoughts = ids.filter((id) => row(id)?.field === 'thinking').length;
  const tools = groups.reduce((count, group) => count + group.toolIds.length, 0);
  const messages = ids.filter((id) => {
    const value = row(id);
    return value?.role === 'user' && senderSession(value.origin) !== null;
  }).length;
  return [
    thoughts
      ? tr(thoughts === 1 ? '{count} thought' : '{count} thoughts', { count: thoughts })
      : '',
    tools ? tr(tools === 1 ? '{count} tool' : '{count} tools', { count: tools }) : '',
    messages
      ? tr(messages === 1 ? '{count} agent message' : '{count} agent messages', {
          count: messages,
        })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function TurnSummary(props: {
  turn: () => TurnPresentation;
  state: TurnViewState;
  groups: () => readonly ProcessGroup[];
  row(id: string): Row | undefined;
  expanded: () => boolean;
  canFold: () => boolean;
  toggle(open: boolean): void;
  /** Folded work keeps its images in reach; open work shows them on each tool. */
  images?: {
    sessionId: string;
    through: () => number;
    refs: () => ToolImageRef[];
    preview(image: ImagePreview): void;
  };
}) {
  const running = computed(() => {
    const turn = props.turn();
    if (turnOutcome(turn) !== null) return (props.state.ran = false);
    return (props.state.ran ||= turn.active);
  });
  const clock = signal<number | undefined>(undefined);
  effect(() => {
    if (!running()) return;
    clock.set(Date.now());
    const timer = setInterval(() => clock.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
  });
  const label = () => {
    const turn = props.turn();
    if (running()) {
      const time = elapsed(turn, clock());
      return time !== null && time >= 1000
        ? tr('Working for {duration}', { duration: formatDuration(time) })
        : tr('Working…');
    }
    const outcome = turnOutcome(turn);
    const time = duration(turn, clock());
    const status =
      outcome === 'failed'
        ? time
          ? tr('Failed after {duration}', { duration: time })
          : tr('Failed')
        : outcome === 'aborted'
          ? time
            ? tr('Stopped after {duration}', { duration: time })
            : tr('Stopped')
          : time
            ? tr('Worked for {duration}', { duration: time })
            : '';
    const counts =
      platform.idiom !== 'terminal' && props.canFold()
        ? activityCounts(props.groups(), props.row)
        : '';
    const usage = turn.finalOutputIds.length === 0 ? turn.timing?.executorUsage : null;
    return (
      [status, counts, usage ? executorUsageLabel(usage) : ''].filter(Boolean).join(' · ') ||
      tr('Completed')
    );
  };
  const choose = (action: { turnKey: string; open: boolean }) => {
    if (props.turn().turnKey === action.turnKey && props.canFold()) props.toggle(action.open);
  };
  return (
    <View style={{ marginTop: 8, marginBottom: platform.idiom === 'terminal' ? 0 : 8 }}>
      <Disclosure
        label={tr('Turn work details')}
        open={props.expanded()}
        foldable={props.canFold()}
        terminalInset={controlStyle.paddingHorizontal}
        onPress={inputAction(choose, {
          turnKey: props.turn().turnKey,
          open: !props.expanded(),
        })}
        trailing={
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <If when={props.images && !props.expanded() && props.images.refs().length > 0}>
              <ToolImageStrip
                sessionId={props.images!.sessionId}
                through={props.images!.through}
                images={props.images!.refs}
                preview={props.images!.preview}
              />
            </If>
          </View>
        }
      >
        <Text
          style={[
            {
              ...disclosureTitleStyle,
              color:
                turnOutcome(props.turn()) === 'failed'
                  ? C.danger
                  : running()
                    ? C.secondary
                    : C.muted,
            },
            { numberOfLines: 1 },
          ]}
        >
          {label()}
        </Text>
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

function ActivityEdgeFade(props: { bottom?: boolean }) {
  return (
    <Canvas
      accessibilityElementsHidden
      style={{
        position: 'absolute',
        left: -8,
        right: 0,
        top: props.bottom ? undefined : 0,
        bottom: props.bottom ? 0 : undefined,
        height: activityEdgeFadeHeight,
        pointerEvents: 'none',
      }}
      draw={(cx, size) => {
        const fade = cx.createLinearGradient(0, 0, 0, size.height);
        const clear = `${C.panel}00`;
        fade.addColorStop(0, props.bottom ? clear : C.panel);
        fade.addColorStop(1, props.bottom ? C.panel : clear);
        cx.fillStyle = fade;
        cx.fillRect(0, 0, size.width, size.height);
      }}
    />
  );
}

function ActivityLog(props: {
  group: () => ProcessGroup;
  toolProgress(id: string): ToolActivity['phase'] | null;
  row(id: string): Row | undefined;
  rowState(id: string): MessageViewState;
  state: GroupViewState;
  sessionId: string;
  through: () => number;
  viewport: () => { width: number; height: number };
  previewImage(image: ImagePreview): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  senders?: MessageSenders;
  inspectTool?(key: string): void;
  userScroll(): void;
  reading(away: boolean): void;
  /** Whether the activity list is scrolled to its end, following or not. */
  settled?(atEnd: boolean): void;
  reveal(): void;
}) {
  const state = props.state;
  const lease = ++state.lease;
  const initial = signal<{ y: number } | null>(null);
  const measurements = signal(0);
  const fadeTop = signal(false);
  const fadeBottom = signal(false);
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
  let activityScrollIntent = false;
  let nearEnd = false;
  let atEnd = false;
  let lastOffset = 0;
  let alive = true;
  const resumeFollowing = () => {
    const resuming = !state.following();
    state.following.set(true);
    props.reading(false);
    // Returning from a reading pause must replace the native reading pin that
    // was captured while end-following was disabled.
    if (resuming) {
      if (atEnd) ownList?.scrollToEnd({ animated: false });
      else ownList?.scrollToOffset({ offset: lastOffset, animated: false });
    }
  };
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
    const available = Math.max(16, Math.min(windowSize().height / 2, viewportHeight - chrome));
    return platform.idiom === 'terminal' ? Math.floor(available / 16) * 16 : available;
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
            state.following() ? { autoscrollToBottomThreshold: activityFollowThreshold } : {}
          }
          scrollbar={true}
          onScrollIntent={() => {
            if (!alive || lease !== state.lease) return;
            activityScrollIntent = true;
            props.userScroll();
            if (nearEnd) resumeFollowing();
          }}
          onScroll={(event) => {
            if (!alive || lease !== state.lease) return;
            lastOffset = event.offset.y;
            const end = Math.max(0, event.contentSize.height - event.size.height);
            const distance = end - lastOffset;
            if (platform.idiom !== 'terminal') {
              fadeTop.set(end > 1 && lastOffset > 1);
              fadeBottom.set(end > 1 && distance > 1);
            }
            nearEnd = distance <= activityFollowThreshold;
            atEnd = distance <= 1;
            props.settled?.(atEnd);
            // Layout scroll reports must not release a tool-reading pause;
            // user input on the activity list does, even with the tool still open.
            if (
              nearEnd &&
              !activityScrollIntent &&
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
            if (nearEnd) resumeFollowing();
            else {
              state.following.set(false);
              props.reading(true);
            }
          }}
          contentStyle={{ paddingLeft: platform.idiom === 'terminal' ? 0 : 8, paddingRight: 8 }}
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
          style={{ height: bodyHeight(), marginLeft: platform.idiom === 'terminal' ? 0 : -8 }}
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
                      toolProgress={props.toolProgress}
                      inspectTool={props.inspectTool}
                      onToolReading={(key) => {
                        if (
                          !alive ||
                          lease !== state.lease ||
                          key !== ownedId() ||
                          !props.group().rowIds.includes(key) ||
                          !props.rowState(key).expanded()
                        )
                          return;
                        activityScrollIntent = false;
                        state.following.set(false);
                        props.reading(true);
                      }}
                      sessionId={props.sessionId}
                      through={props.through}
                      previewImage={props.previewImage}
                      openLink={props.openLink}
                      senders={props.senders}
                      userScroll={props.userScroll}
                      onExpand={(key) => {
                        if (!alive || !ownList) return;
                        activityScrollIntent = false;
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
        <If when={fadeTop()}>
          <ActivityEdgeFade />
        </If>
        <If when={fadeBottom()}>
          <ActivityEdgeFade bottom />
        </If>
      </If>
      <If when={error()}>
        <Text style={{ color: C.danger }}>{error()}</Text>
      </If>
    </View>
  );
}

type TurnPanelProps = {
  group: () => ProcessGroup;
  toolProgress(id: string): ToolActivity['phase'] | null;
  turn: () => TurnPresentation;
  toolActivity: () => ToolActivity | undefined;
  /** The group's tools whose calls are still streaming in, without a row of their own yet. */
  liveTools: () => readonly ToolActivity[];
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
  senders?: MessageSenders;
  inspectTool?(key: string): void;
  userScroll(): void;
  reading(away: boolean): void;
  settled?(atEnd: boolean): void;
};

export function TurnPanel(props: TurnPanelProps) {
  // On the desktop the turn's summary row is the only disclosure: groups have no
  // header of their own and show their members whenever the turn is open.
  if (platform.idiom !== 'terminal')
    effect(() => {
      if (props.state.open() || !props.group().rowIds.length) return;
      const live = !props.group().closed;
      props.state.opening = live ? 'bottom' : 'top';
      props.state.following.set(live);
      props.state.open.set(true);
    });
  return (
    <View style={platform.idiom === 'terminal' ? panelStyle : { ...panelStyle, gap: 0 }}>
      <If when={platform.idiom === 'terminal'}>
        <GroupHeader {...props} />
      </If>
      <If when={props.state.open() && props.group().rowIds.length > 0}>
        <ActivityLog {...props} />
      </If>
      <If when={platform.idiom !== 'terminal'}>
        <Each of={props.liveTools()} key={(tool: ToolActivity) => tool.toolUseId}>
          {(tool) => <LiveToolRow activity={tool} />}
        </Each>
      </If>
    </View>
  );
}

function GroupHeader(props: TurnPanelProps) {
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
  const counts = () => activityCounts([props.group()], props.row) || tr('Process');
  const desiredTitle = computed(() => {
    if (!active()) return counts();
    const activity = props.activity();
    if (activity.kind === 'waiting') return tr('Waiting for your response');
    const tool = props.toolActivity();
    if (tool)
      return toolActivitySummary(
        tool,
        tool.phase === 'preparing' ? tr('Preparing tool') : tr('Running tool'),
        tool.title ? displayText(tool.title) : tool.source === 'native' ? '' : undefined,
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
      <If when={active()}>
        <LoadingIndicator label={stableTitle()} />
      </If>
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
  );
}

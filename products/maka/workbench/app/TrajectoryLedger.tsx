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

import { activityTitle } from './toolActivityPresentation';
import { computed, inputAction, PanResponder, platform, Scroll, signal, Text, View } from 'nsh';
import type { JSX, ViewRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { formatDuration } from './duration';
import type { Row } from './history';
import { Icon } from './Icon';
import type { ImagePreview } from './ImageThumbnail';
import { tr } from './locale';
import { MessageRow, type MessageViewState } from './MessageRow';
import { turnOutcome, type TurnPresentation } from './processGroups';
import type { ToolActivity } from './toolActivity';
import {
  type AgentHistoryRequest,
  type TrajectoryRange,
  trajectoryOverlaps,
  type trajectoryTimeline,
  trajectoryZoom,
} from './trajectory';
import {
  C,
  captionTextStyle,
  controlStyle,
  Disclosure,
  IconButton,
  inputTextStyle,
  textTooltip,
} from './ui';

export function trajectoryRole(row: Row): string {
  if (row.tool || row.role === 'tool_call' || row.role === 'tool_result') return tr('Tool');
  if (row.field === 'thinking') return tr('Thinking');
  switch (row.role) {
    case 'assistant':
      return tr('Assistant output');
    case 'user':
      return tr('User input');
    case 'compaction':
      return tr('Context compaction');
    case 'system':
    case 'context':
      return tr('Context');
    case 'failure':
      return tr('Error');
    default:
      return row.role;
  }
}

export function trajectoryLabel(row: Row): string {
  return row.tool?.call ? activityTitle(row.tool.call) : trajectoryRole(row);
}

function timeOfDay(value: number | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

const timestamp = (row: Row) => timeOfDay(row.timestamp);
const oneLine = (text: string) => text.slice(0, 300).replace(/\s+/g, ' ').trim();

const ellipsis = { numberOfLines: 1, textOverflow: 'ellipsis' } as const;

export function TrajectoryToolbar(props: {
  query(): string;
  search(value: string): void;
  allCollapsed(): boolean;
  canFold(): boolean;
  toggleAll(): void;
  canFoldSubcalls(): boolean;
  subcallsCollapsed(): boolean;
  toggleSubcalls(): void;
  hasOlder(): boolean;
  loadOlder(): Promise<boolean>;
}) {
  const loading = signal(false);
  const older = async () => {
    if (loading()) return;
    loading.set(true);
    try {
      await props.loadOlder();
    } finally {
      loading.set(false);
    }
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 4,
        borderBottomWidth: 1,
        borderBottomColor: C.line,
      }}
    >
      <Input
        accessibilityLabel={tr('Search execution records')}
        placeholder={tr('Search loaded records…')}
        value={props.query()}
        onChange={({ value }) => props.search(value)}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          ...inputTextStyle,
          flex: 1,
          minWidth: 0,
          height: platform.idiom === 'terminal' ? 16 : 30,
          paddingHorizontal: 8,
          color: C.text,
          placeholderColor: C.muted,
          backgroundColor: C.surface,
          borderRadius: 6,
        }}
      />
      <IconButton
        icon="children"
        label={props.allCollapsed() ? tr('Expand all turns') : tr('Collapse all turns')}
        disabled={!props.canFold()}
        onPress={props.toggleAll}
      />
      <IconButton
        icon="activity"
        label={props.subcallsCollapsed() ? tr('Expand all subcalls') : tr('Collapse all subcalls')}
        disabled={!props.canFoldSubcalls()}
        onPress={props.toggleSubcalls}
      />
      <If when={props.hasOlder()}>
        <IconButton
          icon="up"
          label={loading() ? tr('Loading session history…') : tr('Load older records')}
          disabled={loading()}
          onPress={() => void older()}
        />
      </If>
    </View>
  );
}

type Timeline = ReturnType<typeof trajectoryTimeline>;

function timelineTime(value: number, milliseconds: boolean): string {
  const time = timeOfDay(value);
  return milliseconds ? time + '.' + String(Math.floor(value) % 1000).padStart(3, '0') : time;
}

function timelineRangeLabel(range: TrajectoryRange): string {
  const subsecond = range.end - range.start < 10_000;
  const start = timelineTime(range.start, subsecond);
  const end = timelineTime(range.end, subsecond);
  if (new Date(range.start).toDateString() === new Date(range.end).toDateString())
    return start + ' – ' + end;
  return (
    new Date(range.start).toLocaleDateString() +
    ' ' +
    start +
    ' – ' +
    new Date(range.end).toLocaleDateString() +
    ' ' +
    end
  );
}

const requestDuration = (ms: number) => (ms < 1_000 ? ms + ' ms' : formatDuration(ms, true));

function firstTokenLatency(start: number | null | undefined, first: number | null | undefined) {
  if (start == null || first == null || first < start) return undefined;
  return requestDuration(first - start);
}

function TimelineLane(props: {
  points(): Timeline['turns'];
  window(): TrajectoryRange;
  width(): number;
  x(time: number): number;
  jump(key: string): void;
  describe(time: string): string;
}) {
  const visible = computed(() =>
    props
      .points()
      .filter((point) =>
        trajectoryOverlaps(props.window(), point.start, point.end ?? point.firstToken),
      ),
  );
  return (
    <View style={{ position: 'relative', height: 16, backgroundColor: C.surface }}>
      <Each of={visible()} key={(point) => point.key}>
        {(point) => {
          const left = () => Math.min(Math.max(0, props.width() - 4), props.x(point().start));
          const right = () => props.x(point().end ?? point().firstToken ?? point().start);
          const length = () => Math.max(4, right() - left());
          const label = () => props.describe(timelineTime(point().start, true));
          const latency = () => firstTokenLatency(point().start, point().firstToken);
          return (
            <Button
              accessibilityLabel={label()}
              tooltip={textTooltip(() => {
                const value = latency();
                return value ? label() + ' · ' + tr('First token latency') + ' ' + value : label();
              })}
              onPress={inputAction(props.jump, point().key)}
              style={{
                position: 'absolute',
                left: left(),
                top: 2,
                width: length(),
                height: 12,
                minWidth: 0,
                minHeight: 0,
                padding: 0,
                overflow: 'hidden',
                cursor: 'crosshair',
                backgroundColor:
                  point().outcome === 'error'
                    ? C.danger
                    : point().outcome === 'aborted'
                      ? C.warning
                      : point().end == null
                        ? C.muted
                        : C.accent,
                borderRadius: 2,
              }}
              hoverStyle={{ opacity: 0.65 }}
              focusStyle={{ backgroundColor: C.text }}
            >
              <If when={latency() !== undefined}>
                <View
                  style={{
                    pointerEvents: 'none',
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: Math.max(0, props.x(point().firstToken!) - left()),
                    backgroundColor: C.background,
                    opacity: 0.52,
                  }}
                />
              </If>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}

export function TrajectoryOverview(props: {
  timeline(): Timeline;
  selection(): TrajectoryRange | null;
  select(range: TrajectoryRange | null): void;
  jump(key: string): void;
}) {
  const zoom = signal<TrajectoryRange | null>(null);
  const drag = signal<TrajectoryRange | null>(null);
  const width = signal(0);
  let tracks: ViewRef | undefined;
  let left = 0;
  let anchor: number | undefined;
  let dragWindow: TrajectoryRange | undefined;
  const domain = () => props.timeline().domain;
  const window = computed(() => {
    const all = domain();
    if (!all) return null;
    const view = zoom();
    return view ? trajectoryZoom(all, (view.start + view.end) / 2, view.end - view.start) : all;
  });
  const span = () => window()!.end - window()!.start;
  const activeRange = () => drag() ?? props.selection();
  const x = (time: number) =>
    Math.min(width(), Math.max(0, ((time - window()!.start) / span()) * width()));
  const zoomBy = (factor: number) => {
    const all = domain();
    const view = window();
    if (!all || !view) return;
    const focus = factor < 1 ? (props.selection() ?? view) : view;
    const size = factor < 1 ? Math.min(span() / 2, focus.end - focus.start) : span() * factor;
    const next = trajectoryZoom(all, (focus.start + focus.end) / 2, size);
    zoom.set(next.end - next.start < all.end - all.start ? next : null);
  };
  const updateDrag = (pageX: number) => {
    const view = dragWindow;
    if (anchor === undefined || !view || width() <= 0) return;
    const at = (position: number) =>
      view.start +
      Math.round(Math.max(0, Math.min(1, (position - left) / width())) * (view.end - view.start));
    drag.set({ start: at(Math.min(anchor, pageX)), end: at(Math.max(anchor, pageX)) });
  };
  const pan = PanResponder.create({
    onStartShouldSetPanResponderCapture: (event) => {
      anchor = event.pageX;
      return false;
    },
    onMoveShouldSetPanResponderCapture: (_, gesture) =>
      Math.abs(gesture.dx) >= 5 && Math.abs(gesture.dx) >= Math.abs(gesture.dy),
    onPanResponderGrant: (event) => {
      dragWindow = window() ?? undefined;
      updateDrag(event.pageX);
    },
    onPanResponderMove: (event) => updateDrag(event.pageX),
    onPanResponderRelease: (event) => {
      updateDrag(event.pageX);
      const range = drag();
      drag.set(null);
      if (range) props.select(range);
    },
    onPanResponderTerminate: () => drag.set(null),
  });

  return (
    <If when={window() !== null}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 4, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={{ ...captionTextStyle, ...ellipsis, flex: 1, color: C.muted }}>
            {timelineRangeLabel(activeRange() ?? window()!)}
          </Text>
          <If when={props.selection() !== null}>
            <IconButton
              icon="close"
              label={tr('Clear timeline selection')}
              onPress={() => props.select(null)}
            />
          </If>
          <IconButton
            icon="minus"
            label={tr('Zoom out timeline')}
            disabled={zoom() === null}
            onPress={() => zoomBy(2)}
          />
          <IconButton
            icon="plus"
            label={tr('Zoom in timeline')}
            disabled={span() <= 1}
            onPress={() => zoomBy(0.5)}
          />
          <IconButton
            icon="expand"
            label={tr('Fit timeline')}
            disabled={zoom() === null}
            onPress={() => zoom.set(null)}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ gap: 4, width: platform.idiom === 'terminal' ? 80 : 114 }}>
            <If when={props.timeline().turns.length > 0}>
              <Text style={{ ...captionTextStyle, ...ellipsis, height: 16, color: C.muted }}>
                {tr('Timeline turns')}
              </Text>
            </If>
            <If when={props.timeline().requests.length > 0}>
              <Text style={{ ...captionTextStyle, ...ellipsis, height: 16, color: C.muted }}>
                {tr('Timeline requests')}
              </Text>
            </If>
          </View>
          <View
            ref={tracks}
            onLayout={async ({ bounds }) => {
              width.set(bounds.size.width);
              const measured = await tracks?.measure();
              if (measured) left = measured.pagePosition.x;
            }}
            {...pan.panHandlers}
            style={{ position: 'relative', flex: 1, gap: 4, cursor: 'crosshair' }}
          >
            <If when={props.timeline().turns.length > 0}>
              <TimelineLane
                points={() => props.timeline().turns}
                window={() => window()!}
                width={width}
                x={x}
                jump={props.jump}
                describe={(time) => tr('Go to turn at {time}', { time })}
              />
            </If>
            <If when={props.timeline().requests.length > 0}>
              <TimelineLane
                points={() => props.timeline().requests}
                window={() => window()!}
                width={width}
                x={x}
                jump={props.jump}
                describe={(time) => tr('Go to request at {time}', { time })}
              />
            </If>
            <If
              when={
                activeRange() !== null &&
                trajectoryOverlaps(window()!, activeRange()!.start, activeRange()!.end)
              }
            >
              <View
                style={{
                  position: 'absolute',
                  pointerEvents: 'none',
                  left: x(activeRange()!.start),
                  width: Math.max(1, x(activeRange()!.end) - x(activeRange()!.start)),
                  top: 0,
                  bottom: 0,
                  backgroundColor: C.accent,
                  opacity: 0.27,
                  borderRadius: 2,
                  borderWidth: 1,
                  borderColor: C.text,
                }}
              />
            </If>
          </View>
        </View>
      </View>
    </If>
  );
}

export function TrajectoryTurn(props: {
  turn(): TurnPresentation;
  opening(): Row | undefined;
  collapsed(): boolean;
  canFold(): boolean;
  toggle(): void;
}) {
  const title = () => {
    const opening = props.opening();
    const text = opening?.role === 'user' ? oneLine(opening.text) : '';
    return text || timeOfDay(props.turn().timing?.startedAt) || tr('Execution turn');
  };
  const summary = () => {
    const turn = props.turn();
    const outcome = turnOutcome(turn);
    const time = turn.timing;
    const status =
      outcome === 'failed'
        ? tr('Failed')
        : outcome === 'aborted'
          ? tr('Stopped')
          : outcome === 'completed'
            ? tr('Completed')
            : turn.active
              ? tr('Working…')
              : '';
    const duration = time?.finished ? formatDuration(time.finished.at - time.startedAt) : '';
    return [status, duration].filter(Boolean).join(' · ');
  };
  return (
    <View style={{ backgroundColor: C.surface, paddingHorizontal: 4, marginTop: 4 }}>
      <Disclosure
        label={tr('Execution turn')}
        open={!props.collapsed()}
        foldable={props.canFold()}
        onPress={props.toggle}
        trailing={<Text style={{ ...captionTextStyle, color: C.muted }}>{summary()}</Text>}
      >
        <Text style={{ ...captionTextStyle, ...ellipsis, color: C.text, flex: 1, minWidth: 0 }}>
          {title()}
        </Text>
      </Disclosure>
    </View>
  );
}

const requestLabel = (request: AgentHistoryRequest) =>
  request.purpose === 'summary' ? tr('Compaction request') : tr('Model request');

function requestStatus(request: AgentHistoryRequest): string {
  switch (request.finished?.outcome) {
    case 'success':
      return tr('Completed');
    case 'error':
      return tr('Failed');
    case 'aborted':
      return tr('Stopped');
    case 'unknown':
      return tr('Unknown');
    default:
      return request.startedAt == null ? tr('Input recorded') : tr('Working…');
  }
}

export function TrajectoryRequest(props: {
  request(): AgentHistoryRequest;
  selected(): boolean;
  select(): void;
}) {
  return (
    <Button
      accessibilityLabel={tr('Inspect model request {model}', { model: props.request().modelId })}
      selected={props.selected()}
      onPress={props.select}
      style={{
        ...controlStyle,
        backgroundColor: props.selected() ? C.raised : C.surface,
        width: '100%',
        borderRadius: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: 1,
        borderBottomColor: C.line,
      }}
      hoverStyle={{ backgroundColor: C.card }}
      focusStyle={{ backgroundColor: C.raised }}
    >
      <Icon name="bot" color={C.muted} />
      <Text style={{ ...captionTextStyle, color: C.muted }}>{requestLabel(props.request())}</Text>
      <Text style={{ ...captionTextStyle, ...ellipsis, color: C.text, flex: 1, minWidth: 0 }}>
        {props.request().modelId}
      </Text>
      <Text style={{ ...captionTextStyle, color: C.muted }}>{requestStatus(props.request())}</Text>
    </Button>
  );
}

function Inspector(props: {
  title(): string;
  subtitle(): string;
  close(): void;
  children: JSX.Element;
}) {
  return (
    <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: C.surface }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 8,
          borderBottomWidth: 1,
          borderBottomColor: C.line,
        }}
      >
        <Text style={{ ...captionTextStyle, ...ellipsis, color: C.text, flex: 1, minWidth: 0 }}>
          {props.title()}
        </Text>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{props.subtitle()}</Text>
        <IconButton icon="close" label={tr('Close record details')} onPress={props.close} />
      </View>
      <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 8 }}>
        {props.children}
      </Scroll>
    </View>
  );
}

export function TrajectoryRequestInspector(props: {
  request(): AgentHistoryRequest;
  close(): void;
}) {
  const metrics = () => {
    const { startedAt, firstTokenAt, finished, estimatedInputTokens, contextWindow, inputLimit } =
      props.request();
    const usage = finished?.usage;
    return [
      { label: tr('Started at'), value: startedAt == null ? undefined : timeOfDay(startedAt) },
      { label: tr('Finished at'), value: finished ? timeOfDay(finished.at) : undefined },
      {
        label: tr('Duration'),
        value:
          startedAt != null && finished
            ? requestDuration(Math.max(0, finished.at - startedAt))
            : undefined,
      },
      { label: tr('First token latency'), value: firstTokenLatency(startedAt, firstTokenAt) },
      { label: tr('Estimated input tokens'), value: estimatedInputTokens },
      { label: tr('Context window (tokens)'), value: contextWindow },
      { label: tr('Effective input limit'), value: inputLimit },
      { label: tr('Input tokens'), value: usage?.input_tokens },
      { label: tr('Output tokens'), value: usage?.output_tokens },
      { label: tr('Reasoning tokens'), value: usage?.reasoning_tokens },
      { label: tr('Cache read tokens'), value: usage?.cache_read_tokens },
      { label: tr('Cache write tokens'), value: usage?.cache_write_tokens },
    ].filter(({ value }) => value != null);
  };
  return (
    <Inspector
      title={() => requestLabel(props.request())}
      subtitle={() => requestStatus(props.request())}
      close={props.close}
    >
      <View style={{ gap: 6, paddingHorizontal: 4 }}>
        <Text style={{ ...captionTextStyle, color: C.text }}>{props.request().modelId}</Text>
        <If when={props.request().finished?.diagnostic}>
          <Text style={{ ...captionTextStyle, color: C.warning, userSelect: 'text' }}>
            {props.request().finished?.diagnostic}
          </Text>
        </If>
        <Each of={metrics()} key={(metric) => metric.label}>
          {(metric) => (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>{metric().label}</Text>
              <Text style={{ ...captionTextStyle, color: C.text }}>{metric().value}</Text>
            </View>
          )}
        </Each>
      </View>
    </Inspector>
  );
}

export function TrajectoryRecord(props: {
  row(): Row;
  selected(): boolean;
  progress(): ToolActivity['phase'] | null;
  select(): void;
  canFold(): boolean;
  folded(): boolean;
  toggle?(): void;
}) {
  const summary = () => {
    const row = props.row();
    return row.tool ? trajectoryLabel(row) : oneLine(row.text);
  };
  const status = () => {
    const row = props.row();
    if (row.tool?.result?.settlement === 'unknown') return tr('Unknown');
    if (row.tool?.result?.settlement === 'rejected') return tr('Rejected');
    if (row.tool?.result?.isError || row.role === 'failure') return tr('Error');
    if (
      props.progress() === 'running' ||
      (props.progress() === 'preparing' && row.tool?.call?.dispatched)
    )
      return tr('Running tool');
    if (props.progress() === 'preparing') return tr('Preparing tool');
    return timestamp(row);
  };
  const depth = () => Math.min(3, props.row().tool?.call?.ancestorToolUseIds.length ?? 0);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: C.line,
      }}
    >
      <Button
        accessibilityLabel={tr('Inspect {record}', {
          record: trajectoryLabel(props.row()),
        })}
        tooltip={textTooltip(summary)}
        selected={props.selected()}
        onPress={props.select}
        style={{
          ...controlStyle,
          backgroundColor: props.selected() ? C.raised : C.background,
          flex: 1,
          minWidth: 0,
          borderRadius: 0,
          paddingLeft: 8 + 12 * depth(),
          paddingRight: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
        hoverStyle={{ backgroundColor: C.surface }}
        focusStyle={{ backgroundColor: C.raised }}
      >
        <Text
          style={{
            ...captionTextStyle,
            ...ellipsis,
            width: platform.idiom === 'terminal' ? 80 : 108,
            color: C.muted,
          }}
        >
          {trajectoryRole(props.row())}
        </Text>
        <Text style={{ ...captionTextStyle, ...ellipsis, color: C.text, flex: 1, minWidth: 0 }}>
          {summary()}
        </Text>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{status()}</Text>
      </Button>
      <If when={props.canFold()}>
        <IconButton
          icon={props.folded() ? 'right' : 'down'}
          label={props.folded() ? tr('Expand tool subcalls') : tr('Collapse tool subcalls')}
          onPress={props.toggle!}
        />
      </If>
    </View>
  );
}

export function TrajectoryInspector(props: {
  row(): Row;
  rowId: string;
  sessionId: string;
  through(): number;
  previewImage(image: ImagePreview): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  toolProgress(id: string): ToolActivity['phase'] | null;
  maxHeight(): number;
  close(): void;
}) {
  const viewState: MessageViewState = { expanded: signal(true), sourceMode: signal(false) };
  return (
    <Inspector
      title={() => trajectoryLabel(props.row())}
      subtitle={() => timestamp(props.row())}
      close={props.close}
    >
      <MessageRow
        item={props.row}
        ownerKey={() => props.rowId}
        sessionId={props.sessionId}
        through={props.through}
        viewState={viewState}
        previewImage={props.previewImage}
        openLink={props.openLink}
        toolProgress={props.toolProgress}
        toolMaxHeight={props.maxHeight}
        userScroll={() => {}}
      />
    </Inspector>
  );
}

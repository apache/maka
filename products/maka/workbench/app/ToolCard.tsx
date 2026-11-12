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

import { tr } from './locale';
import { formatDuration } from './duration';
import { computed, effect, inputAction, platform, Scroll, signal, Text, View } from 'nsh';
import type { HistoryTool } from '../../../../packages/plugin-sdk/src/index.js';
import type { Row } from './history';
import type { MessageSenders } from './messageSenders';
import type { ImagePreview } from './ImageThumbnail';
import { ToolImage, ToolImageStrip, toolImages } from './ToolImage';
import {
  createToolSource,
  OriginalToolSource,
  type ToolSourceRef,
  type ToolSource,
} from './ToolSource';
import {
  cardFamily,
  processFamily,
  toolArguments,
  toolResult,
  type ToolProjection,
} from './toolCards';
import {
  activityFailure,
  activityIcon,
  activityPresentation,
  activityProjection,
  activityTitle,
} from './toolActivityPresentation';
import { ToolReader } from './ToolReader';
import {
  C,
  captionTextStyle,
  controlStyle,
  Disclosure,
  disclosureContentInset,
  disclosureTitleStyle,
  IconButton,
  textTooltip,
} from './ui';
import { LoadingIndicator } from './Loading';
import { toolActivitySummary, type ToolActivity } from './toolActivity';
import { Icon } from './Icon';
import { viewRuntimeContext } from './plugins/viewContext';
import { PluginView } from './plugins/PluginView';
import { useHost } from './host';

const detailsGap = 8;
const cardPadding = { top: 12, right: 12, bottom: 12, left: disclosureContentInset(0) };
const cardStyle = () => ({
  backgroundColor: C.card,
  borderRadius: 12,
  paddingTop: cardPadding.top,
  paddingRight: cardPadding.right,
  paddingBottom: cardPadding.bottom,
  paddingLeft: cardPadding.left,
});

type StatusKind =
  | 'recorded'
  | 'success'
  | 'error'
  | 'unknown'
  | 'rejected'
  | 'stopped'
  | 'dispatched'
  | 'pending'
  | 'preparing'
  | 'running';

const statusIcons = {
  error: 'statusError',
  unknown: 'statusUnknown',
  rejected: 'statusError',
  stopped: 'statusStopped',
  dispatched: 'statusDispatched',
  pending: 'statusPending',
} as const;

/** The row's trailing state lane: empty while the tool is healthy. */
function Status(props: { label: string; kind?: StatusKind }) {
  const active = () => props.kind === 'preparing' || props.kind === 'running';
  const silent = () => !props.kind || props.kind === 'success' || props.kind === 'recorded';
  const color = () =>
    props.kind === 'error'
      ? C.danger
      : props.kind === 'unknown' || props.kind === 'rejected'
        ? C.warning
        : C.muted;
  return (
    <View
      accessible={!active() && !silent()}
      accessibilityLabel={props.label}
      tooltip={silent() ? undefined : textTooltip(() => props.label)}
      style={{
        width: 20,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <If when={!silent()}>
        <If
          when={active()}
          else={<Icon name={statusIcons[props.kind as keyof typeof statusIcons]} color={color()} />}
        >
          <LoadingIndicator label={props.label} color={color()} />
        </If>
      </If>
    </View>
  );
}

function reference(tool: HistoryTool, field: 'arguments' | 'result'): ToolSourceRef | null {
  const position = (field === 'arguments' ? tool.call : tool.result)?.position;
  return position
    ? {
        field,
        position,
        toolUseId: tool.toolUseId,
        name: tool.call?.name,
        presentation: tool.call ? tool.call.presentation : undefined,
        callPosition: tool.call?.position ?? null,
        resultPosition: tool.result?.position ?? null,
        key: JSON.stringify([field, tool.toolUseId, position, tool.call?.presentation ?? null]),
      }
    : null;
}

function ProcessOutcome(props: { reference: ToolSourceRef; sessionId: string; through: number }) {
  const host = useHost();
  const status = createToolSource(host, props.reference, props.sessionId, props.through, [
    'value',
    'status',
  ]);
  return (
    <If when={status.complete() && !status.error()} else={<Status label={tr('Recorded')} />}>
      <Each of={[status.content()]}>
        {(value) => {
          const phase = value();
          const settled = ['completed', 'failed', 'timed_out', 'cancelled'].includes(phase);
          const exit = settled
            ? createToolSource(host, props.reference, props.sessionId, props.through, [
                'value',
                'exitCode',
              ])
            : null;
          const code = () => exit?.json();
          const failed = () =>
            ['failed', 'timed_out', 'orphaned'].includes(phase) ||
            (typeof code() === 'number' && code() !== 0);
          const label = () => {
            if (phase === 'cancelled') return tr('Stopped');
            if (phase === 'orphaned') return tr('Unknown');
            if (failed()) return tr('Error');
            if (phase === 'completed') return tr('Completed');
            if (phase === 'starting') return tr('Preparing at capture');
            return phase === 'running' ? tr('Running at capture') : tr('Recorded');
          };
          return (
            <Status
              label={`${label()}${typeof code() === 'number' ? ` · ${tr('Exit {code}', { code: String(code()) })}` : ''}`}
              kind={
                phase === 'orphaned'
                  ? 'unknown'
                  : phase === 'cancelled'
                    ? 'stopped'
                    : failed()
                      ? 'error'
                      : phase === 'completed'
                        ? 'success'
                        : 'recorded'
              }
            />
          );
        }}
      </Each>
    </If>
  );
}

function Outcome(props: { reference: ToolSourceRef; sessionId: string; through: number }) {
  const host = useHost();
  const kind = createToolSource(host, props.reference, props.sessionId, props.through, ['kind']);
  return (
    <If when={kind.complete() && !kind.error()} else={<Status label={tr('Recorded')} />}>
      <If
        when={kind.content() === 'completed'}
        else={
          <Status
            label={kind.content() === 'failed' ? tr('Error') : tr('Recorded')}
            kind={kind.content() === 'failed' ? 'error' : 'recorded'}
          />
        }
      >
        <ProcessOutcome
          reference={props.reference}
          sessionId={props.sessionId}
          through={props.through}
        />
      </If>
    </If>
  );
}

function Field(props: {
  reference: ToolSourceRef;
  sessionId: string;
  through: number;
  original(): boolean;
  userScroll(): void;
  tool(): HistoryTool;
  source?: ToolSource;
  writeResult?: ToolSource;
  senders?: MessageSenders;
  /** Called once a complete result is read, with whether its view shows a process's command. */
  showsCommand?(shown: boolean): void;
}) {
  const host = useHost();
  const plugins = viewRuntimeContext()!;
  const source =
    props.source ?? createToolSource(host, props.reference, props.sessionId, props.through);
  const family = cardFamily(source.original.presentation);
  const renderer = () => plugins.renderer(source.original.presentation);
  const presentation = activityPresentation(source.original.presentation);
  const value = computed(() => (source.format() === 'json' ? source.json() : source.content()));
  const projection = computed<ToolProjection | null>(() => {
    if (!source.complete() || source.error()) return null;
    const result = props.tool().result;
    if (props.reference.field === 'result' && result?.isError && (presentation || family)) {
      const failure = activityFailure(value());
      if (failure) return failure;
    }
    if (presentation) {
      const projected = activityProjection(presentation, props.reference.field, value(), {
        returned: result?.settlement === 'returned' && !result.isError,
        sessionTitle: (id) => props.senders?.session(id)?.title,
      });
      if (projected) return projected;
    }
    if (props.reference.field !== 'arguments') return toolResult(family, value());
    const target = props.tool().call?.externalTarget;
    switch (target?.kind) {
      case 'command':
        return {
          kind: 'sections',
          sections: [
            { label: tr('Requested command'), text: target.command, style: 'code' },
            ...(target.cwd ? [{ label: tr('Working directory'), text: target.cwd }] : []),
          ],
        };
      case 'file':
        return {
          kind: 'sections',
          sections: [{ label: tr('File'), text: target.path, style: 'code' }],
        };
      case 'search':
        return { kind: 'sections', sections: [{ label: tr('Search query'), text: target.query }] };
      default:
        const argument = toolArguments(family, value());
        if (
          argument?.kind === 'change' &&
          argument.value.phase === 'requested' &&
          argument.value.operation === 'write' &&
          props.writeResult?.complete()
        ) {
          const write = toolResult('write', props.writeResult.json());
          if (
            write?.kind === 'change' &&
            write.value.phase === 'recorded' &&
            write.value.operation === 'write' &&
            write.value.previous !== null
          )
            return { kind: 'change', value: { ...argument.value, previous: write.value.previous } };
        }
        return argument;
    }
  });
  effect(() => {
    if (props.showsCommand && (source.complete() || source.error()))
      props.showsCommand(!renderer() && !source.error() && projection()?.kind === 'process');
  });
  return (
    <If
      when={
        props.original() ||
        (source.complete() &&
          (!props.writeResult || props.writeResult.complete() || !!props.writeResult.error())) ||
        source.error() ||
        !(family || presentation || renderer())
      }
      else={<LoadingIndicator label={tr('Reading details…')} color={C.muted} />}
    >
      <If
        when={!props.original() && !!renderer() && source.complete() && !source.error()}
        else={
          <If
            when={!props.original() && projection() !== null}
            else={
              <OriginalToolSource
                source={source}
                label={
                  props.reference.field === 'arguments'
                    ? tr('Original arguments')
                    : !props.original() && props.tool().call?.origin === 'executor'
                      ? tr('Output')
                      : tr('Original result')
                }
              />
            }
          >
            <View selectable>
              <ToolReader value={projection()!} source={source} userScroll={props.userScroll} />
            </View>
          </If>
        }
      >
        <Each of={renderer() ? [renderer()!] : []} key={(item) => item.key}>
          {(item) => (
            <PluginView
              runtime={plugins}
              contribution={item()}
              sessionId={() => props.sessionId}
              tool={() => ({
                field: props.reference.field,
                value: value(),
                sessionId: props.sessionId,
                through: props.through,
                tool: props.tool(),
                userScroll: props.userScroll,
              })}
            />
          )}
        </Each>
      </If>
    </If>
  );
}

function WriteFields(
  props: Omit<Parameters<typeof Field>[0], 'reference' | 'source' | 'writeResult'> & {
    argumentsRef: ToolSourceRef;
    resultRef: ToolSourceRef;
  },
) {
  const result = createToolSource(useHost(), props.resultRef, props.sessionId, props.through);
  return (
    <>
      <Field {...props} reference={props.resultRef} source={result} />
      <Field {...props} reference={props.argumentsRef} writeResult={result} />
    </>
  );
}

/** A tool whose call is still streaming in has no record to open yet. */
export function LiveToolRow(props: { activity(): ToolActivity }) {
  const phase = () =>
    props.activity().phase === 'preparing' ? tr('Preparing tool') : tr('Running tool');
  const title = () => {
    const value = props.activity();
    return value.source === 'native' && !value.title ? phase() : activityTitle(value);
  };
  return (
    <Disclosure
      label={toolActivitySummary(props.activity(), phase(), title())}
      icon="activity"
      open={false}
      foldable={false}
      terminalInset={controlStyle.paddingHorizontal}
      onPress={() => {}}
      trailing={<Status label={phase()} kind={props.activity().phase} />}
    >
      <Text
        style={[
          { ...disclosureTitleStyle, color: C.secondary },
          { numberOfLines: 1, textOverflow: 'ellipsis' },
        ]}
      >
        {title()}
      </Text>
    </Disclosure>
  );
}

export function ToolCard(props: {
  row(): Row;
  progress?(): ToolActivity['phase'] | null;
  sessionId: string;
  ownerKey(): string;
  through(): number;
  expanded(): boolean;
  original(): boolean;
  maxHeight(): number;
  reading?(): void;
  expand(action: { sessionId: string; key: string; value: boolean }): void;
  showOriginal(action: { sessionId: string; key: string; value: boolean }): void;
  inspect?(key: string): void;
  previewImage(image: ImagePreview): void;
  userScroll(): void;
  senders?: MessageSenders;
}) {
  const tool = (): HistoryTool | null => props.row().tool ?? null;
  const family = () => cardFamily(tool()?.call?.presentation);
  const externalTarget = () => tool()?.call?.externalTarget;
  const icon = () => {
    switch (externalTarget()?.kind) {
      case 'command':
        return 'terminal';
      case 'file':
        return 'file';
      case 'search':
        return 'search';
      default:
        return activityIcon(tool()?.call?.presentation);
    }
  };
  const title = () => {
    const call = tool()?.call;
    return progress() === 'preparing' && !call?.presentation && !call?.title
      ? tr('Preparing tool')
      : activityTitle(call);
  };
  // Open at the recorded output; the complete original arguments remain below,
  // except a process's command once its recorded result shows it. Until that
  // result is read, a successful settlement is taken to show it.
  const resultShowsCommand = signal<boolean | null>(null);
  const plugins = viewRuntimeContext();
  const presentation = () => activityPresentation(tool()?.call?.presentation);
  const progress = () => {
    const phase = props.progress?.();
    return phase === 'preparing' && tool()?.call?.dispatched ? 'running' : phase;
  };
  const references = () =>
    tool()
      ? (['result', 'arguments'] as const).flatMap((field) => {
          const value = reference(tool()!, field);
          const result = tool()!.result;
          const descriptor = presentation();
          if (
            !props.original() &&
            descriptor &&
            !plugins?.renderer(value?.presentation) &&
            field === 'result' &&
            result?.image &&
            !result.isError
          )
            return [];
          if (
            !props.original() &&
            descriptor &&
            !descriptor[field] &&
            !plugins?.renderer(value?.presentation) &&
            (field === 'arguments' || !result?.isError)
          )
            return [];
          if (
            field === 'arguments' &&
            !props.original() &&
            processFamily(family()) &&
            (resultShowsCommand() ?? (result?.settlement === 'returned' && !result.isError))
          )
            return [];
          return value ? [value] : [];
        })
      : [];
  const result = () => (tool() ? reference(tool()!, 'result') : null);
  const writeFields = computed(() => {
    const call = tool();
    if (
      family() !== 'write' ||
      !call?.result ||
      call.result.isError ||
      plugins?.renderer(call.call?.presentation)
    )
      return [];
    const argumentsRef = reference(call, 'arguments');
    const resultRef = reference(call, 'result');
    return argumentsRef && resultRef ? [{ argumentsRef, resultRef }] : [];
  });
  const readDetails = () => {
    props.userScroll();
    props.reading?.();
  };
  const images = () => toolImages(tool());
  const imageThrough = () => props.row().metadataThrough ?? props.through();
  const fallbackState = (): { label: string; kind: StatusKind } => {
    const value = tool();
    if (value?.result) {
      if (value.result.settlement === 'unknown') return { label: tr('Unknown'), kind: 'unknown' };
      if (value.result.settlement === 'rejected')
        return { label: tr('Rejected'), kind: 'rejected' };
      if (value.result.isError || value.result.settlement === 'failed')
        return { label: tr('Error'), kind: 'error' };
      if (value.call?.origin === 'executor') return { label: tr('Completed'), kind: 'success' };
      return { label: tr('Recorded'), kind: 'recorded' };
    }
    // History references describe their fence, never current execution liveness.
    return value?.call
      ? value.call.dispatched
        ? { label: tr('Dispatched'), kind: 'dispatched' }
        : { label: tr('Input recorded'), kind: 'pending' }
      : { label: tr('Not completed'), kind: 'pending' };
  };
  const resultDetails = () => {
    const details = tool()?.result?.details;
    const exit = details?.exitCode;
    const time = details?.durationMs;
    return [
      exit == null ? '' : tr('Exit {code}', { code: String(exit) }),
      time == null ? '' : formatDuration(time, true),
    ]
      .filter(Boolean)
      .join(' · ');
  };
  return (
    <View style={{ width: '100%', minWidth: 0, gap: detailsGap }}>
      <Disclosure
        label={tr('Toggle tool {name}', {
          name: title(),
        })}
        tooltip={title()}
        icon={icon()}
        open={props.expanded()}
        terminalInset={controlStyle.paddingHorizontal}
        onPress={inputAction(props.expand, {
          sessionId: props.sessionId,
          key: props.ownerKey(),
          value: !props.expanded(),
        })}
        trailing={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <If when={platform.idiom !== 'terminal' && images().length > 0}>
              <ToolImageStrip
                sessionId={props.sessionId}
                through={imageThrough}
                images={images}
                preview={props.previewImage}
              />
            </If>
            <If when={props.expanded() && props.inspect !== undefined}>
              <IconButton
                label={tr('Inspect in execution process')}
                icon="children"
                onPress={inputAction((key: string) => props.inspect?.(key), props.ownerKey())}
              />
            </If>
            <If when={props.expanded()}>
              <IconButton
                label={tr('Toggle original tool details')}
                tooltip={
                  props.original()
                    ? tr('Show readable tool details')
                    : tr('Show original tool data')
                }
                icon="code"
                selected={props.original()}
                onPress={inputAction(props.showOriginal, {
                  sessionId: props.sessionId,
                  key: props.ownerKey(),
                  value: !props.original(),
                })}
              />
            </If>
            <If
              when={progress() != null}
              else={
                <If
                  when={
                    processFamily(family()) &&
                    result() &&
                    tool()?.result?.settlement === 'returned' &&
                    !tool()?.result?.isError
                  }
                  else={<Status label={fallbackState().label} kind={fallbackState().kind} />}
                >
                  <Each of={result() ? [result()!] : []} key={(value) => value.key}>
                    {(value) => (
                      <Outcome
                        reference={value()}
                        sessionId={props.sessionId}
                        through={props.row().metadataThrough ?? props.through()}
                      />
                    )}
                  </Each>
                </If>
              }
            >
              <Status
                label={progress() === 'preparing' ? tr('Preparing tool') : tr('Running tool')}
                kind={progress() ?? 'running'}
              />
            </If>
          </View>
        }
      >
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1 }}
        >
          <Text
            style={[
              {
                ...captionTextStyle,
                minWidth: 0,
                flexShrink: 1,
                color: props.expanded() ? C.text : C.secondary,
              },
              { numberOfLines: 1, textOverflow: 'ellipsis' },
            ]}
          >
            {title()}
          </Text>
          <If when={platform.idiom !== 'terminal'}>
            <Icon name={props.expanded() ? 'down' : 'right'} size={12} color={C.muted} />
          </If>
        </View>
      </Disclosure>
      <If when={props.expanded()}>
        <View style={platform.idiom === 'terminal' ? { paddingLeft: 16 } : cardStyle()}>
          <Scroll
            accessibilityLabel={tr('Tool details')}
            onScrollIntent={readDetails}
            style={{
              minHeight: 16,
              minWidth: 0,
              maxHeight: Math.max(
                16,
                props.maxHeight() -
                  controlStyle.minHeight -
                  detailsGap -
                  (platform.idiom === 'terminal' ? 0 : cardPadding.top + cardPadding.bottom),
              ),
            }}
            contentStyle={{ gap: 16 }}
          >
            <If when={resultDetails() !== ''}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{resultDetails()}</Text>
            </If>
            <Each of={images()} key={(value) => value.key}>
              {(value) => (
                <ToolImage
                  sessionId={props.sessionId}
                  through={imageThrough}
                  position={value().position}
                  image={value().image}
                  preview={props.previewImage}
                />
              )}
            </Each>
            <If
              when={writeFields().length > 0}
              else={
                <Each of={references()} key={(value) => value.key}>
                  {(value) => (
                    <Field
                      reference={value()}
                      sessionId={props.sessionId}
                      through={props.row().metadataThrough ?? props.through()}
                      original={props.original}
                      userScroll={readDetails}
                      tool={() => tool()!}
                      senders={props.senders}
                      showsCommand={
                        value().field === 'result'
                          ? (shown) => resultShowsCommand.set(shown)
                          : undefined
                      }
                    />
                  )}
                </Each>
              }
            >
              <Each of={writeFields()} key={(fields) => fields.resultRef.key}>
                {(fields) => (
                  <WriteFields
                    argumentsRef={fields().argumentsRef}
                    resultRef={fields().resultRef}
                    sessionId={props.sessionId}
                    through={props.row().metadataThrough ?? props.through()}
                    original={props.original}
                    userScroll={readDetails}
                    tool={() => tool()!}
                  />
                )}
              </Each>
            </If>
            <If when={!references().length && images().length === 0}>
              <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}>
                {presentation()
                  ? result()
                    ? tr('No additional details')
                    : tr('Waiting for tool result')
                  : props.row().text ||
                    tr('Original tool source is unavailable in this history row.')}
              </Text>
            </If>
          </Scroll>
        </View>
      </If>
    </View>
  );
}

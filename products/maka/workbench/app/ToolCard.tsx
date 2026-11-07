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

import { displayText, tr } from './locale';
import { computed, inputAction, platform, Scroll, Text, View } from 'nsh';
import type { HistoryTool } from '../../../../packages/plugin-sdk/src/index.js';
import type { Row } from './history';
import type { ImagePreview } from './ImageThumbnail';
import { ToolImage, ToolImageStrip, toolImages } from './ToolImage';
import { createToolSource, OriginalToolSource, type ToolSourceRef } from './ToolSource';
import { cardFamily, processFamily, toolArguments, toolResult, type ToolFamily } from './toolCards';
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
import type { ToolActivity } from './toolActivity';
import { Icon } from './Icon';
import { viewRuntimeContext } from './plugins/viewContext';
import { PluginView } from './plugins/PluginView';
import { useHost } from './host';

const detailsGap = 8;
// The 32-point copy button in the card's first row is concentric with its corner.
const cardPadding = { top: 4, right: 4, bottom: 12, left: disclosureContentInset(0) };
const cardStyle = () => ({
  backgroundColor: C.surface,
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

const familyIcon = (family: ToolFamily) =>
  processFamily(family)
    ? 'terminal'
    : family === 'read' || family === 'fetch'
      ? 'file'
      : family === 'write' || family === 'edit' || family === 'patch'
        ? 'edit'
        : family === 'glob' || family === 'grep' || family === 'webSearch'
          ? 'search'
          : 'activity';

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
        key: JSON.stringify([
          field,
          tool.toolUseId,
          position.sourceSequence,
          position.itemIndex,
          tool.call?.presentation ?? null,
        ]),
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
        <If
          when={processFamily(cardFamily(props.reference.presentation))}
          else={<Status label={tr('Completed')} kind="success" />}
        >
          <ProcessOutcome
            reference={props.reference}
            sessionId={props.sessionId}
            through={props.through}
          />
        </If>
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
}) {
  const host = useHost();
  const plugins = viewRuntimeContext()!;
  const source = createToolSource(host, props.reference, props.sessionId, props.through);
  const family = cardFamily(source.original.presentation);
  const renderer = () => plugins.renderer(source.original.presentation);
  const value = computed(() => (source.format() === 'json' ? source.json() : source.content()));
  const projection = computed(() =>
    props.reference.field === 'arguments'
      ? toolArguments(family, value())
      : toolResult(family, value()),
  );
  return (
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
  previewImage(image: ImagePreview): void;
  userScroll(): void;
}) {
  const tool = (): HistoryTool | null => props.row().tool ?? null;
  const family = () => cardFamily(tool()?.call?.presentation);
  const title = () => {
    const supplied = tool()?.call?.title;
    if (supplied) return displayText(supplied);
    switch (family()) {
      case 'read':
        return tr('Read file');
      case 'write':
        return tr('Write file');
      case 'edit':
        return tr('Edit file');
      case 'patch':
        return tr('Patch file');
      case 'glob':
        return tr('Find files');
      case 'grep':
        return tr('Search files');
      case 'execute':
        return tr('Run command');
      case 'processRead':
        return tr('Read process output');
      case 'stdin':
        return tr('Send process input');
      case 'stop':
        return tr('Stop process');
      case 'fetch':
        return tr('Read web page');
      case 'webSearch':
        return tr('Search the web');
      default:
        return tool()?.call?.name ?? tr('Tool');
    }
  };
  // Open at the recorded output; the complete original arguments remain below,
  // except a process's command, which its recorded result already shows.
  const references = () =>
    tool()
      ? (['result', 'arguments'] as const).flatMap((field) => {
          const value = reference(tool()!, field);
          if (
            field === 'arguments' &&
            !props.original() &&
            processFamily(family()) &&
            tool()!.result
          )
            return [];
          return value ? [value] : [];
        })
      : [];
  const result = () => (tool() ? reference(tool()!, 'result') : null);
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
      return { label: tr('Recorded'), kind: 'recorded' };
    }
    // History references describe their fence, never current execution liveness.
    return value?.call
      ? value.call.dispatched
        ? { label: tr('Dispatched'), kind: 'dispatched' }
        : { label: tr('Input recorded'), kind: 'pending' }
      : { label: tr('Not completed'), kind: 'pending' };
  };
  return (
    <View style={{ width: '100%', minWidth: 0, gap: detailsGap }}>
      <Disclosure
        label={tr('Toggle tool {name}', {
          name: tool()?.call?.name ?? tr('Tool details'),
        })}
        tooltip={title()}
        icon={familyIcon(family())}
        open={props.expanded()}
        terminalInset={controlStyle.paddingHorizontal}
        onPress={inputAction(props.expand, {
          sessionId: props.sessionId,
          key: props.ownerKey(),
          value: !props.expanded(),
        })}
        trailing={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <If when={!platform.isTerminal && images().length > 0}>
              <ToolImageStrip
                sessionId={props.sessionId}
                through={imageThrough}
                images={images}
                preview={props.previewImage}
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
              when={props.progress?.() != null}
              else={
                <If
                  when={
                    family() &&
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
                label={
                  props.progress?.() === 'preparing' ? tr('Preparing tool') : tr('Running tool')
                }
                kind={props.progress?.() ?? 'running'}
              />
            </If>
          </View>
        }
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
      <If when={props.expanded()}>
        <View style={platform.isTerminal ? { paddingLeft: 16 } : cardStyle()}>
          <Scroll
            accessibilityLabel={tr('Tool details')}
            onScrollIntent={() => {
              props.userScroll();
              props.reading?.();
            }}
            style={{
              minHeight: 16,
              minWidth: 0,
              maxHeight: Math.max(
                16,
                props.maxHeight() -
                  controlStyle.minHeight -
                  detailsGap -
                  (platform.isTerminal ? 0 : cardPadding.top + cardPadding.bottom),
              ),
            }}
            contentStyle={{ gap: 16 }}
          >
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
            <Each of={references()} key={(value) => value.key}>
              {(value) => (
                <Field
                  reference={value()}
                  sessionId={props.sessionId}
                  through={props.row().metadataThrough ?? props.through()}
                  original={props.original}
                  userScroll={props.userScroll}
                  tool={() => tool()!}
                />
              )}
            </Each>
            <If when={!references().length}>
              <Text style={[{ color: C.muted }, { userSelect: 'text' }]}>
                {props.row().text || tr('Original tool source is unavailable in this history row.')}
              </Text>
            </If>
          </Scroll>
        </View>
      </If>
    </View>
  );
}

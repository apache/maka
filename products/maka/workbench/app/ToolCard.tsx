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
import { ToolImage } from './ToolImage';
import { createToolSource, OriginalToolSource, type ToolSourceRef } from './ToolSource';
import { cardFamily, processFamily, toolArguments, toolResult } from './toolCards';
import { ToolReader } from './ToolReader';
import {
  C,
  captionTextStyle,
  controlStyle,
  Disclosure,
  disclosureTitleStyle,
  IconButton,
} from './ui';
import { Icon } from './Icon';
import { viewRuntimeContext } from './plugins/viewContext';
import { PluginView } from './plugins/PluginView';
import { useHost } from './host';

const detailsGap = 8;

function Status(props: { label: string; success?: boolean; error?: boolean; warning?: boolean }) {
  const color = () => (props.error ? C.danger : props.warning ? C.warning : C.muted);
  return (
    <View
      accessible
      accessibilityLabel={props.label}
      style={[
        { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
        { pointerEvents: 'none' },
      ]}
    >
      <Icon name={props.error ? 'close' : props.success ? 'check' : 'activity'} color={color()} />
      <If when={!props.success}>
        <Text style={{ ...captionTextStyle, color: color() }}>{props.label}</Text>
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
              success={phase === 'completed' && !failed()}
              error={phase !== 'cancelled' && failed()}
              warning={phase === 'cancelled'}
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
            error={kind.content() === 'failed'}
          />
        }
      >
        <If
          when={processFamily(cardFamily(props.reference.presentation))}
          else={<Status label={tr('Completed')} success />}
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
  // Open at the recorded output; the complete original arguments remain below.
  const references = () =>
    tool()
      ? (['result', 'arguments'] as const).flatMap((field) => {
          const value = reference(tool()!, field);
          return value ? [value] : [];
        })
      : [];
  const result = () => (tool() ? reference(tool()!, 'result') : null);
  const fallbackState = () => {
    const value = tool();
    if (value?.result)
      return value.result.settlement === 'unknown'
        ? tr('Unknown')
        : value.result.isError || value.result.settlement === 'failed'
          ? tr('Error')
          : value.result.settlement === 'rejected'
            ? tr('Rejected')
            : tr('Recorded');
    // History references describe their fence, never current execution liveness.
    return value?.call
      ? value.call.dispatched
        ? tr('Dispatched')
        : tr('Input recorded')
      : tr('Not completed');
  };
  return (
    <View style={{ width: '100%', minWidth: 0, gap: detailsGap }}>
      <Disclosure
        label={tr('Toggle tool {name}', {
          name: tool()?.call?.name ?? tr('Tool details'),
        })}
        tooltip={title()}
        open={props.expanded()}
        terminalInset={controlStyle.paddingHorizontal}
        onPress={inputAction(props.expand, {
          sessionId: props.sessionId,
          key: props.ownerKey(),
          value: !props.expanded(),
        })}
        trailing={
          <If when={props.expanded()}>
            <IconButton
              label={tr('Toggle original tool details')}
              tooltip={
                props.original() ? tr('Show readable tool details') : tr('Show original tool data')
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
        <If
          when={
            family() &&
            result() &&
            tool()?.result?.settlement === 'returned' &&
            !tool()?.result?.isError
          }
          else={
            <Status
              label={fallbackState()}
              error={fallbackState() === tr('Error')}
              warning={fallbackState() === tr('Rejected') || fallbackState() === tr('Unknown')}
            />
          }
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
      </Disclosure>
      <If when={props.expanded()}>
        {/* On the desktop the details start under the title, as thinking text does. */}
        <View style={{ paddingLeft: platform.isTerminal ? 16 : 32 }}>
          <Scroll
            accessibilityLabel={tr('Tool details')}
            onScrollIntent={props.userScroll}
            onScroll={() => props.reading?.()}
            style={{
              minHeight: 16,
              minWidth: 0,
              maxHeight: Math.max(16, props.maxHeight() - controlStyle.minHeight - detailsGap),
            }}
            contentStyle={{ gap: 16, paddingRight: platform.isTerminal ? 0 : 12 }}
          >
            <If when={tool()?.result?.image}>
              <ToolImage
                sessionId={props.sessionId}
                through={() => props.row().metadataThrough ?? props.through()}
                position={tool()!.result!.position}
                preview={props.previewImage}
              />
            </If>
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

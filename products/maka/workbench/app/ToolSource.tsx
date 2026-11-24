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

import type { HistoryRowAddress } from '../../../../packages/plugin-sdk/src/index.js';
import { createText, UiError, errorText } from './text';
import { tr } from './locale';
import { cleanup, Clipboard, computed, inputAction, platform, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { AgentHistorySourceRead } from '../../../../packages/plugin-sdk/src/index.js';
import { sameValue } from '../../../../plugins/shared/value';
import type { Host } from './host';
import { messageBytes } from './history';
import { Icon } from './Icon';
import {
  C,
  captionTextStyle,
  cardFocusStyle,
  codeTextStyle,
  controlStyle,
  textTooltip,
} from './ui';

export type ToolSourceRef = {
  key: string;
  field: 'arguments' | 'result';
  toolUseId: string;
  position: HistoryRowAddress;
  name?: string;
  presentation?: string | null;
  callPosition: HistoryRowAddress | null;
  resultPosition: HistoryRowAddress | null;
};

// One mounted reader owns one immutable field/path at its opening fence.
// It is shared by the readable card and its literal original-details view.
export function createToolSource(
  host: Host,
  reference: ToolSourceRef,
  sessionId: string,
  through: number,
  path: NonNullable<AgentHistorySourceRead['path']> | null = null,
) {
  const original = {
    ...reference,
    position: { ...reference.position },
    callPosition: reference.callPosition ? { ...reference.callPosition } : null,
    resultPosition: reference.resultPosition ? { ...reference.resultPosition } : null,
    sessionId,
    through,
    path: path === null ? null : (path.slice() as NonNullable<AgentHistorySourceRead['path']>),
  };
  const content = signal(''),
    total = signal<number | null>(null),
    format = signal('');
  const busy = signal(false),
    error = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const complete = () => total() !== null && messageBytes(content()) === total();
  const read = async () => {
    if (!alive || busy() || complete()) return;
    const offset = messageBytes(content());
    busy.set(true);
    error.set('');
    try {
      const page = await host.query('agent', 'source', {
        sessionId: original.sessionId,
        through: original.through,
        source: { kind: 'row', position: original.position },
        field: original.field,
        ...(original.path === null ? {} : { path: original.path }),
        position: offset === 0 ? { kind: 'start' } : { kind: 'after', offset },
      });
      if (!alive) return;
      const source = page.source,
        tool = source?.tool;
      const owned = original.field === 'arguments' ? tool?.call : tool?.result;
      const end = offset + messageBytes(source?.text ?? '');
      if (
        page.kind !== 'ready' ||
        page.through !== original.through ||
        source?.field !== original.field ||
        !sameValue(source.path ?? null, original.path) ||
        !sameValue(source.position, original.position) ||
        tool?.toolUseId !== original.toolUseId ||
        !sameValue(owned?.position, original.position) ||
        !sameValue(tool?.call?.position ?? null, original.callPosition) ||
        !sameValue(tool?.result?.position ?? null, original.resultPosition) ||
        (original.name !== undefined && tool?.call?.name !== original.name) ||
        (original.presentation !== undefined &&
          tool?.call?.presentation !== original.presentation) ||
        source.offset !== offset ||
        messageBytes(content()) !== offset ||
        !Number.isSafeInteger(source.totalBytes) ||
        source.totalBytes < 0 ||
        end > source.totalBytes ||
        (total() !== null && source.totalBytes !== total()) ||
        (end === offset && end !== source.totalBytes) ||
        (format() !== '' && source.format !== format()) ||
        !(
          source.format === 'text' ||
          source.format === 'json' ||
          (original.field === 'result' && source.format === 'image_descriptor')
        )
      )
        throw new UiError('The original tool source could not be verified.');
      total.set(source.totalBytes);
      format.set(source.format);
      content.set(content() + source.text);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not read the tool details.'));
    } finally {
      if (alive) {
        busy.set(false);
        if (!complete() && !error()) void read();
      }
    }
  };
  void Promise.resolve().then(read);
  const json = (): unknown => {
    if (!complete() || error() || format() !== 'json') return undefined;
    try {
      return JSON.parse(content());
    } catch {
      return undefined;
    }
  };
  return { original, content, total, format, busy, error, complete, read, json };
}
export type ToolSource = ReturnType<typeof createToolSource>;

export function ToolFieldDivider() {
  return (
    <If when={platform.idiom !== 'terminal'}>
      <View
        accessibilityElementsHidden
        style={[{ height: 1, backgroundColor: C.line }, { pointerEvents: 'none' }]}
      />
    </If>
  );
}

export function ToolCopyButton(props: { text(): string; label: string; source: ToolSource }) {
  const feedback = signal<{ text: string; error: string } | null>(null);
  let alive = true;
  let pending = false;
  cleanup(() => {
    alive = false;
  });
  const action = computed(() => {
    const originalText = props.text();
    const owns = () =>
      alive && props.source.complete() && !props.source.error() && props.text() === originalText;
    return inputAction(async () => {
      if (!owns() || pending) return;
      pending = true;
      try {
        await Clipboard.writeText(originalText);
        if (owns()) feedback.set({ text: originalText, error: '' });
      } catch (reason) {
        if (owns())
          feedback.set({
            text: originalText,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      } finally {
        pending = false;
      }
    }, null);
  });
  const current = () => (feedback()?.text === props.text() ? feedback() : null);
  const copied = () => current() !== null && !current()!.error;
  return (
    <View style={{ alignItems: 'flex-end', minWidth: 32, flexShrink: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'none' }]}>
          {copied() ? tr('Copied') : ''}
        </Text>
        <Button
          accessibilityLabel={props.label}
          tooltip={textTooltip(() => (copied() ? tr('Copied') : props.label))}
          onPress={action()}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={{ backgroundColor: C.cardRaised }}
          focusStyle={cardFocusStyle()}
        >
          <Icon name={copied() ? 'check' : 'copy'} color={C.secondary} />
        </Button>
      </View>
      <If when={current()?.error}>
        <Text style={[{ ...captionTextStyle, color: C.danger }, { userSelect: 'text' }]}>
          {current()!.error}
        </Text>
      </If>
    </View>
  );
}

export function OriginalToolSource(props: { source: ToolSource; label: string; tone?: 'output' }) {
  const source = props.source;
  const textColor = () =>
    props.tone === 'output' && platform.idiom !== 'terminal' ? C.secondary : C.text;
  return (
    <View style={{ minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text
          style={[
            { ...captionTextStyle, color: C.muted, flex: 1, minWidth: 0 },
            { numberOfLines: 1, textOverflow: 'ellipsis', userSelect: 'none' },
          ]}
        >
          {props.label}
        </Text>
        <If when={source.complete() && !source.error() && source.content() !== ''}>
          <ToolCopyButton
            label={tr('Copy {label}', { label: props.label })}
            text={source.content}
            source={source}
          />
        </If>
      </View>
      <Text style={[{ color: textColor(), ...codeTextStyle }, { userSelect: 'text' }]}>
        {source.content()}
      </Text>
      <If when={source.error()}>
        <Text style={{ color: C.danger }}>{source.error()}</Text>
      </If>
      <If when={!source.complete()}>
        <Button
          disabled={!source.error()}
          style={controlStyle}
          hoverStyle={{ backgroundColor: C.cardRaised }}
          focusStyle={{ backgroundColor: C.line }}
          onPress={inputAction(source.read, {
            sessionId: source.original.sessionId,
            key: source.original.key,
            through: source.original.through,
          })}
        >
          <Text style={{ color: C.muted }}>
            {source.error() ? tr('Retry original source') : tr('Reading…')} ·{' '}
            {messageBytes(source.content())}/{source.total() ?? '?'} {tr('bytes')}
          </Text>
        </Button>
      </If>
    </View>
  );
}

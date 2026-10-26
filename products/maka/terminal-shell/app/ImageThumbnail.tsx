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

import { textTooltip } from './ui';
import { createText } from './text';
import { cleanup, inputAction, signal, Text, View, Image } from 'nsh';
import { Button } from 'nsh/base';
import { windowSize } from 'nsh';
import type { YNode } from 'nsh';
import { C, captionTextStyle, controlStyle } from './ui';
import { Icon } from './Icon';
import { immutableAsset } from './immutableAsset';
import { tr } from './locale';
import type {
  AgentToolImageRead,
  AgentAttachmentImageRead,
} from '../../../../packages/plugin-sdk/src/index.js';

export type PreviewSource =
  | { kind: 'tool-image'; read: AgentToolImageRead }
  | { kind: 'attachment-image'; read: AgentAttachmentImageRead };
export type ImagePreview = {
  source: PreviewSource;
  uri: string;
  width: number;
  height: number;
  restoreFocus?(): boolean;
};

export function ImageThumbnail(props: {
  source: PreviewSource;
  compact?: boolean;
  label?: string;
  tooltip?: string;
  preview(image: ImagePreview): void;
}) {
  const source = props.source;
  const uri =
    source.kind === 'tool-image'
      ? immutableAsset('tool-image', source.read)
      : immutableAsset('attachment-image', source.read);
  const action = Object.freeze({ sessionId: source.read.sessionId, uri });
  const size = signal<{ width: number; height: number } | null>(null);
  const error = createText();
  const attempt = signal(0);
  let alive = true;
  let button: YNode | undefined;
  cleanup(() => {
    alive = false;
  });
  const owns = (selected: typeof action) =>
    selected.sessionId === action.sessionId && selected.uri === action.uri;
  const preview = (selected: typeof action) => {
    const originalButton = button;
    if (alive && owns(selected) && size())
      props.preview({
        source,
        uri,
        ...size()!,
        restoreFocus: () => {
          if (!alive || !size() || !originalButton || button !== originalButton) return false;
          originalButton.focus();
          return true;
        },
      });
  };
  const retry = (selected: typeof action) => {
    if (!alive || !owns(selected) || !error()) return;
    size.set(null);
    error.set('');
    attempt.set(attempt() + 1);
  };
  return (
    <View
      style={
        props.compact
          ? { flexDirection: 'row', alignItems: 'flex-start', gap: 8, flexShrink: 0 }
          : { gap: 16 }
      }
    >
      <Button
        ref={(node) => {
          button = node;
        }}
        accessibilityLabel={props.label ?? tr('Open image preview')}
        tooltip={textTooltip(() => props.compact
            ? `${props.tooltip ?? props.label ?? tr('Open image preview')}\n${
                size()
                  ? `${size()!.width} × ${size()!.height}`
                  : error()
                    ? tr('Image unavailable')
                    : tr('Loading image…')
              }`
            : undefined)}
        disabled={!size()}
        onPress={inputAction(preview, action)}
        style={
          props.compact
            ? {
                width: 64,
                height: 64,
                flexShrink: 0,
                backgroundColor: C.surface,
                borderWidth: 1,
                borderColor: C.line,
                borderRadius: 8,
                overflow: 'hidden',
              }
            : {
                alignSelf: 'flex-start',
                maxWidth: '100%',
                backgroundColor: C.surface,
                padding: 8,
                gap: 8,
              }
        }
        hoverStyle={props.compact ? { borderColor: C.secondary } : {}}
        focusStyle={props.compact ? { borderColor: C.accent } : {}}
      >
        <If when={!props.compact}>
          <Text style={{ ...captionTextStyle, color: size() ? C.accent : C.muted }}>
            {size()
              ? tr('Open image · {width} × {height}', {
                  width: size()!.width,
                  height: size()!.height,
                })
              : error()
                ? tr('Image unavailable')
                : tr('Loading image…')}
          </Text>
        </If>
        <Each of={[attempt()]} key={(value: number) => value}>
          {() => (
            <Image
              src={uri}
              resizeMode={props.compact ? 'cover' : 'contain'}
              onLoad={(dimensions) => {
                if (alive) size.set(dimensions);
              }}
              onError={(reason) => {
                if (alive) {
                  size.set(null);
                  error.set(reason.message);
                }
              }}
              style={{
                width: props.compact ? 64 : 320,
                maxWidth: '100%',
                height: props.compact
                  ? 64
                  : Math.max(64, Math.min(192, Math.floor(windowSize().height / 48) * 16)),
              }}
            />
          )}
        </Each>
        <If when={props.compact && !size()}>
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 64,
              height: 64,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="image" color={error() ? C.danger : C.muted} />
          </View>
        </If>
      </Button>
      <If when={error()}>
        <View
          style={{
            width: props.compact ? 240 : undefined,
            maxWidth: '100%',
            gap: props.compact ? 8 : 16,
          }}
        >
          <If when={props.compact}>
            <Text selectable style={{ ...captionTextStyle, color: C.text }}>
              {props.tooltip ?? props.label ?? tr('Image')}
            </Text>
            <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Image unavailable')}</Text>
          </If>
          <Text selectable style={{ color: C.danger }}>
            {error()}
          </Text>
          <Button
            onPress={inputAction(retry, action)}
            style={controlStyle}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={{ backgroundColor: C.line }}
          >
            <Text style={{ color: C.accent }}>{tr('Retry image')}</Text>
          </Button>
        </View>
      </If>
    </View>
  );
}

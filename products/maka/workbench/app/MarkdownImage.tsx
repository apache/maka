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

import { cleanup, inputAction, signal, Text, View, Image } from 'nsh';
import type { YNode } from 'nsh';
import { Button } from 'nsh/base';
import type { TextViewImage } from 'nsh/base';
import { host } from './host';
import { ImageViewer } from './ImageViewer';
import { createText, errorText, UiError } from './text';
import { tr } from './locale';
import { C, captionTextStyle, controlFocusStyle } from './ui';

type Reading = { stream: Awaited<ReturnType<typeof openFile>> | null };
const openFile = (sessionId: string, path: { bytesBase64: string }) =>
  host.subscribe('agent', 'readFile', { sessionId, path });
const close = async (reading: Reading | null) => {
  const stream = reading?.stream;
  if (reading) reading.stream = null;
  await stream?.close();
};

// One real native inline attachment remains mounted through loading and failure.
// Its source atom and paragraph layout are owned by the surrounding Text.
export function MarkdownImageView(props: {
  image(): TextViewImage;
  sessionId: string;
  linked: boolean;
  flow: 'block' | 'inline';
  lineHeight: number;
}) {
  const target = props.image().src;
  const sessionId = props.sessionId;
  const source = signal<{ uri: string } | null>(null);
  const dimensions = signal<{ width: number; height: number } | null>(null);
  const error = createText();
  const viewing = signal(false);
  let reading: Reading | null = null;
  let button: YNode | undefined;
  let alive = true;
  const owns = () => alive && props.sessionId === sessionId && props.image().src === target;
  const read = () => {
    if (!owns()) return;
    const previous = reading;
    const request: Reading = { stream: null };
    reading = request;
    error.set('');
    source.set(null);
    dimensions.set(null);
    void (async () => {
      await close(previous);
      if (!owns() || reading !== request) return;
      const selected = host.markdownImageSource(target);
      if (selected.kind === 'remote') {
        source.set({ uri: selected.uri });
        return;
      }
      const stream = await openFile(sessionId, selected.path);
      if (!owns() || reading !== request) {
        await stream.close();
        return;
      }
      request.stream = stream;
      try {
        const captured = await stream.readFile();
        if (!owns() || reading !== request) return;
        if (captured.kind === 'absent') throw new UiError('This file no longer exists.');
        if (captured.kind === 'changed')
          throw new UiError(
            'This file changed while it was being read. Refresh to capture it again.',
          );
        if (captured.kind !== 'image') throw new UiError('This file is not a supported image.');
        source.set({ uri: captured.uri });
      } finally {
        await close(request);
      }
    })().catch((reason) => {
      if (owns() && reading === request) error.set(errorText(reason));
    });
  };
  cleanup(() => {
    alive = false;
    void close(reading).catch(() => {});
  });
  read();
  const name = () => props.image().alt || target;
  const width = () => dimensions()?.width;
  const aspectRatio = () => {
    const size = dimensions();
    return size ? size.width / size.height : undefined;
  };
  const activate = (selected: { sessionId: string; target: string }) => {
    if (!owns() || selected.sessionId !== sessionId || selected.target !== target) return;
    if (error()) read();
    else if (source() && dimensions()) viewing.set(true);
  };
  const content = () => (
    <View style={{ gap: 4, width: width(), maxWidth: '100%' }}>
      <Each of={source() && !error() ? [source()!] : []} key={(image) => image.uri}>
        {(image) => {
          const captured = image();
          let mounted = true;
          cleanup(() => {
            mounted = false;
          });
          const current = () => owns() && mounted && source() === captured;
          return (
            <Image
              src={captured.uri}
              role="image"
              accessibilityLabel={name()}
              onLoad={(size) => {
                if (current()) dimensions.set(size);
              }}
              onError={(reason) => {
                if (current()) {
                  dimensions.set(null);
                  error.set(reason.message);
                }
              }}
              style={[
                {
                  width: width() === undefined ? undefined : '100%',
                  maxWidth: '100%',
                  height: dimensions() ? undefined : props.lineHeight,
                  aspectRatio: aspectRatio(),
                  flexShrink: 0,
                },
                { pointerEvents: 'none', objectFit: 'contain' },
              ]}
            />
          );
        }}
      </Each>
      <If when={error() || !dimensions()}>
        <Text style={{ ...captionTextStyle, color: error() ? C.danger : C.muted }}>
          {name()}
          {' · '}
          {error() ? `${tr('Image unavailable')}: ${error()}` : tr('Loading image…')}
        </Text>
      </If>
      <If when={error() && !props.linked}>
        <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry image')}</Text>
      </If>
    </View>
  );
  return (
    <View
      style={[
        { width: props.flow === 'block' ? '100%' : undefined, maxWidth: '100%' },
        { pointerEvents: props.linked ? 'none' : undefined },
      ]}
    >
      <If when={!props.linked} else={content()}>
        <Button
          ref={(node) => {
            button = node;
          }}
          accessibilityLabel={tr(error() ? 'Retry image: {name}' : 'View full image: {name}', {
            name: name(),
          })}
          disabled={!error() && !dimensions()}
          onPress={inputAction(activate, { sessionId, target })}
          style={{ padding: 0, alignItems: 'flex-start', backgroundColor: 'transparent' }}
          focusStyle={controlFocusStyle}
        >
          {content()}
        </Button>
      </If>
      <If when={viewing() && source() && dimensions()}>
        <ImageViewer
          image={{ uri: source()!.uri, ...dimensions()!, title: name() }}
          close={() => {
            viewing.set(false);
            if (owns()) button?.focus();
          }}
        />
      </If>
    </View>
  );
}

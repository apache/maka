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
import type { YNode } from 'nsh';
import { createAnimatedValue } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { keymap } from 'nsh';
import { Icon } from './Icon';
import { tr } from './locale';
import { C, captionTextStyle, controlStyle, controlHoverStyle, controlFocusStyle } from './ui';
import { dialogTop } from './chrome';

export type ViewerImage = { uri: string; width: number; height: number; title: string };
export type OpenImageViewer = (image: ViewerImage, restoreFocus: () => boolean) => void;
type ImageControl = 'fit' | 'actual' | 'in' | 'out';

// The mounted resource owns this URI and its original selector. This viewer
// changes presentation only; it never reads a path or retains another byte store.
export function ImageViewerButton(props: { image: ViewerImage; open: OpenImageViewer }) {
  const image = props.image;
  let alive = true;
  let button: YNode | undefined;
  cleanup(() => {
    alive = false;
  });
  const show = (selected: ViewerImage) => {
    if (!alive || selected.uri !== image.uri) return;
    const original = button;
    props.open(selected, () => {
      if (!alive || !original || button !== original) return false;
      original.focus();
      return true;
    });
  };
  return (
    <Button
      ref={(node) => {
        button = node;
      }}
      accessibilityLabel={tr('Open image full screen')}
      tooltip={textTooltip(() => tr('Open full screen'))}
      onPress={inputAction(show, image)}
      style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
      hoverStyle={controlHoverStyle}
      focusStyle={controlFocusStyle}
    >
      <Icon name="expand" color={C.secondary} />
    </Button>
  );
}

export function ImageViewer(props: { image: ViewerImage; close(): void }) {
  const image = props.image;
  const viewport = signal({ width: 0, height: 0 });
  const error = createText();
  const scale = createAnimatedValue(1);
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  let alive = true;
  let unbind = () => {};
  cleanup(() => {
    alive = false;
    unbind();
  });
  const fit = () => Math.min(viewport().width / image.width, viewport().height / image.height);
  const reset = (zoom: number) => {
    scale.set(zoom);
    x.set(0);
    y.set(0);
  };
  const control = (target: { uri: string; kind: ImageControl }) => {
    if (!alive || target.uri !== image.uri) return;
    if (target.kind === 'fit' || target.kind === 'actual') {
      reset(target.kind === 'fit' ? fit() : 1);
    } else {
      const factor = target.kind === 'in' ? 1.25 : 1 / 1.25;
      scale.adjust(factor, 0);
      x.adjust(factor, 0);
      y.adjust(factor, 0);
    }
  };
  const move = (dx: number, dy: number) => {
    if (!alive) return;
    x.adjust(1, dx);
    y.adjust(1, dy);
  };
  const bind = (node: YNode) => {
    unbind();
    unbind = keymap.bind(
      {
        escape: props.close,
        'mod+plus': () => control({ uri: image.uri, kind: 'in' }),
        'mod+shift+plus': () => control({ uri: image.uri, kind: 'in' }),
        'mod+minus': () => control({ uri: image.uri, kind: 'out' }),
        'mod+0': () => control({ uri: image.uri, kind: 'fit' }),
        'mod+1': () => control({ uri: image.uri, kind: 'actual' }),
        left: () => move(16, 0),
        right: () => move(-16, 0),
        up: () => move(0, 16),
        down: () => move(0, -16),
      },
      { when: 'always', repeat: true, within: node },
    );
  };
  return (
    <Dialog animation="none" onOpenChange={props.close} style={{ flex: 1 }}>
      <View
        ref={bind}
        accessibilityLabel={tr('Full screen image viewer')}
        style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: '#000000b3' }}
      >
        <View
          accessibilityLabel={tr('Image viewport')}
          pan={{ x, y }}
          pinch={{ scale }}
          onLayout={(event) => {
            const previous = viewport();
            if (previous.width === event.size.width && previous.height === event.size.height)
              return;
            viewport.set(event.size);
            reset(Math.min(1, fit()));
          }}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'grab',
          }}
        >
          <If when={viewport().width > 0 && viewport().height > 0}>
            <Image
              src={image.uri}
              role="image"
              accessibilityLabel={image.title}
              onError={(reason) => {
                if (alive) error.set(reason.message);
              }}
              style={[
                {
                  width: image.width,
                  height: image.height,
                  flexShrink: 0,
                  transform: [{ translateX: x }, { translateY: y }, { scale }],
                },
                { pointerEvents: 'none', objectFit: 'contain' },
              ]}
            />
          </If>
        </View>
        <View
          style={{
            position: 'absolute',
            top: dialogTop(16),
            left: 16,
            right: 16,
            flexDirection: 'row',
            gap: 16,
            alignItems: 'center',
            pointerEvents: 'box-none',
          }}
        >
          <View style={[{ flex: 1, gap: 4 }, { pointerEvents: 'none' }]}>
            <Text style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 1 }]}>
              {image.title}
            </Text>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {image.width} × {image.height}
            </Text>
            <If when={error()}>
              <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
            </If>
          </View>
          <Button
            accessibilityLabel={tr('Close full screen image')}
            tooltip={textTooltip(() => tr('Close · Esc'))}
            onPress={props.close}
            style={{
              ...controlStyle,
              width: 36,
              height: 36,
              paddingHorizontal: 10,
              borderRadius: 18,
              backgroundColor: '#24262b',
            }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
          >
            <Icon name="close" color={C.text} />
          </Button>
        </View>
        <View
          style={[
            { position: 'absolute', left: 16, right: 16, bottom: 16, alignItems: 'center' },
            { pointerEvents: 'box-none' },
          ]}
        >
          <View
            style={{
              maxWidth: '100%',
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: 4,
              padding: 4,
              borderRadius: 24,
              backgroundColor: '#24262b',
            }}
          >
            <Each
              of={[
                {
                  kind: 'fit' as const,
                  label: () => tr('Fit image to window'),
                  caption: (): string => tr('Fit'),
                },
                {
                  kind: 'actual' as const,
                  label: () => tr('Show image at actual size'),
                  caption: (): string => '100%',
                },
                {
                  kind: 'out' as const,
                  label: () => tr('Zoom image out'),
                  caption: (): string => '−',
                },
                {
                  kind: 'in' as const,
                  label: () => tr('Zoom image in'),
                  caption: (): string => '+',
                },
              ]}
              key={(item) => item.kind}
            >
              {(item) => (
                <Button
                  accessibilityLabel={item().label()}
                  tooltip={textTooltip(() => item().label())}
                  onPress={inputAction(control, { uri: image.uri, kind: item().kind })}
                  style={{
                    ...controlStyle,
                    minWidth: 36,
                    height: 36,
                    paddingHorizontal: 12,
                    borderRadius: 18,
                    alignItems: 'center',
                  }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                >
                  <Text style={{ ...captionTextStyle, color: C.text }}>{item().caption()}</Text>
                </Button>
              )}
            </Each>
          </View>
        </View>
      </View>
    </Dialog>
  );
}

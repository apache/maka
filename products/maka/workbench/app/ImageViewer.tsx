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

import { cleanup, createAnimatedValue, Image, inputAction, keymap, signal, Text, View } from 'nsh';
import type { PinchEvent, PressEvent, ViewRef, WheelEvent } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { controlsLeft, controlsRight, ownTitleBar, TITLE_BAR_HEIGHT } from './chrome';
import { Icon } from './Icon';
import { tr } from './locale';
import { createText } from './text';
import {
  C,
  captionTextStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  defaultColors,
  isDark,
  textTooltip,
} from './ui';

export type ViewerImage = { uri: string; width: number; height: number; title: string };
/** An image the viewer can page to; one without a size is measured when shown. */
export type GalleryImage = { uri: string; title: string; width?: number; height?: number };
export type OpenImageViewer = (image: ViewerImage, restoreFocus: () => boolean) => void;
type ImageControl = 'fit' | 'actual' | 'in' | 'out';

const ZOOM_STEP = 1.25;
const MIN_ZOOM_FLOOR = 0.1;
const MAX_ZOOM_CEIL = 12;
const KEY_PAN_STEP = 32;

// The viewer is dark in every appearance, so its controls take the dark colors.
const DARK = defaultColors(true);
const darkControlStyle = {
  ...controlStyle,
  height: 36,
  borderRadius: 18,
  alignItems: 'center',
} as const;
const darkHoverStyle = { backgroundColor: DARK.line };
const darkFocusStyle = { backgroundColor: DARK.line, borderColor: DARK.accent };

// The mounted resource owns this URI and its original selector. This viewer
// changes presentation only; it never reads a path or retains another byte store.
export function ImageViewerButton(props: { image: ViewerImage; open: OpenImageViewer }) {
  const image = props.image;
  let alive = true;
  let button: ViewRef | undefined;
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
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
    >
      <Icon name="expand" color={C.secondary} />
    </Button>
  );
}

/**
 * A list given as a function may be replaced while it is shown; the viewer
 * stays on the image it shows, by URI.
 */
export function ImageViewer(props: {
  images: readonly GalleryImage[] | (() => readonly GalleryImage[]);
  /** The URI shown first; the first image when absent. */
  start?: string;
  close(): void;
}) {
  const given = props.images;
  const images = typeof given === 'function' ? given : () => given;
  const current = signal(props.start ?? images()[0]!.uri);
  const index = () =>
    Math.max(
      0,
      images().findIndex((item) => item.uri === current()),
    );
  const image = () => images()[index()]!;
  // A replaced list may drop a size the first list carried; the loaded one is kept.
  const measured = signal<{ uri: string; width: number; height: number } | null>(null);
  const size = () => {
    const { uri, width, height } = image();
    if (width !== undefined && height !== undefined) return { width, height };
    const known = measured();
    return known?.uri === uri ? { width: known.width, height: known.height } : null;
  };
  const viewport = signal({ width: 0, height: 0 });
  const error = createText();
  const scale = createAnimatedValue(1);
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  const zoomPercent = signal(100);
  let currentScale = 1;
  let alive = true;
  let closeButton: ViewRef | undefined;
  const fit = () => {
    const area = viewport();
    const shown = size();
    if (!shown || area.width <= 0 || area.height <= 0 || shown.width <= 0 || shown.height <= 0)
      return 1;
    return Math.min(area.width / shown.width, area.height / shown.height);
  };
  const minScale = () => Math.min(MIN_ZOOM_FLOOR, fit() * 0.5);
  const maxScale = () => Math.max(MAX_ZOOM_CEIL, fit() * 8);
  const clampScale = (value: number) => Math.min(maxScale(), Math.max(minScale(), value));
  const reset = (zoom: number) => {
    const next = clampScale(zoom);
    currentScale = next;
    zoomPercent.set(Math.round(next * 100));
    scale.set(next);
    x.set(0);
    y.set(0);
  };
  const zoomBy = (factor: number, anchor?: { x: number; y: number }) => {
    if (!alive || !Number.isFinite(factor) || factor <= 0) return;
    const previous = currentScale;
    const next = clampScale(previous * factor);
    const applied = next / previous;
    if (!Number.isFinite(applied) || Math.abs(applied - 1) < 1e-4) return;
    currentScale = next;
    zoomPercent.set(Math.round(next * 100));
    scale.adjust(applied, 0);
    if (anchor) {
      const size = viewport();
      const offsetX = anchor.x - size.width / 2;
      const offsetY = anchor.y - size.height / 2;
      x.adjust(applied, offsetX * (1 - applied));
      y.adjust(applied, offsetY * (1 - applied));
    } else {
      x.adjust(applied, 0);
      y.adjust(applied, 0);
    }
  };
  const control = (target: { uri: string; kind: ImageControl }) => {
    if (!alive || target.uri !== image().uri) return;
    if (target.kind === 'fit' || target.kind === 'actual') {
      reset(target.kind === 'fit' ? fit() : 1);
    } else {
      zoomBy(target.kind === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP);
    }
  };
  const go = (step: -1 | 1) => {
    const next = images()[index() + step];
    if (!alive || !next) return;
    error.set('');
    current.set(next.uri);
    if (size()) reset(Math.min(1, fit()));
  };
  const move = (dx: number, dy: number) => {
    if (!alive) return;
    x.adjust(1, dx);
    y.adjust(1, dy);
  };
  const handleWheel = (event: WheelEvent) => {
    if (!alive) return;
    const zoomWheel =
      event.deltaMode === 'lines' || event.modifiers.control || event.modifiers.platform;
    if (zoomWheel) {
      if (event.delta.y === 0) return;
      const step = event.deltaMode === 'lines' ? 0.075 : 0.008;
      const exponent = Math.max(-0.5, Math.min(0.5, -event.delta.y * step));
      zoomBy(Math.exp(exponent), event.position);
      return;
    }
    if (event.delta.x !== 0) x.adjust(1, -event.delta.x);
    if (event.delta.y !== 0) y.adjust(1, -event.delta.y);
  };
  const handlePinch = (event: PinchEvent) => {
    if (!alive || event.delta === 0) return;
    const factor = 1 + event.delta;
    if (factor > 0) zoomBy(factor, event.position);
  };
  const handlePinchEnd = ({ scale: gestureScale }: { scale: number }) => {
    if (!alive || !Number.isFinite(gestureScale) || gestureScale <= 0) return;
    const raw = currentScale * gestureScale;
    const clamped = clampScale(raw);
    currentScale = clamped;
    zoomPercent.set(Math.round(clamped * 100));
    const correction = clamped / raw;
    if (Number.isFinite(correction) && Math.abs(correction - 1) > 1e-4) {
      scale.adjust(correction, 0);
    }
  };
  const handleViewportPress = (event?: PressEvent) => {
    if (!alive || event?.clickCount !== 2) return;
    const initial = Math.min(1, fit());
    if (currentScale > initial * 1.05) {
      reset(initial);
    } else {
      const target = initial < 0.98 ? 1 : 2;
      zoomBy(target / currentScale, event.position);
    }
  };
  // Own the window's zoom/pan/dismiss keys while the full-screen modal is open, even after dragging the canvas.
  // Bind both modified and plain zoom keys because desktop menu bars may claim mod+plus/minus/0.
  const unbind = keymap.bind(
    {
      escape: props.close,
      'mod+plus': () => control({ uri: image().uri, kind: 'in' }),
      'mod+shift+plus': () => control({ uri: image().uri, kind: 'in' }),
      plus: () => control({ uri: image().uri, kind: 'in' }),
      'shift+plus': () => control({ uri: image().uri, kind: 'in' }),
      'mod+minus': () => control({ uri: image().uri, kind: 'out' }),
      minus: () => control({ uri: image().uri, kind: 'out' }),
      'mod+0': () => control({ uri: image().uri, kind: 'fit' }),
      '0': () => control({ uri: image().uri, kind: 'fit' }),
      'mod+1': () => control({ uri: image().uri, kind: 'actual' }),
      '1': () => control({ uri: image().uri, kind: 'actual' }),
      // With several images the arrows page through them; dragging still pans.
      left: () => (images().length > 1 ? go(-1) : move(KEY_PAN_STEP, 0)),
      right: () => (images().length > 1 ? go(1) : move(-KEY_PAN_STEP, 0)),
      up: () => move(0, KEY_PAN_STEP),
      down: () => move(0, -KEY_PAN_STEP),
    },
    { when: 'always', repeat: true },
  );
  cleanup(() => {
    alive = false;
    unbind();
  });
  const headerStyle = {
    position: 'absolute',
    flexDirection: 'row',
    gap: 16,
    alignItems: 'center',
    pointerEvents: 'box-none',
    ...(ownTitleBar
      ? {
          top: 0,
          left: 0,
          right: 0,
          minHeight: TITLE_BAR_HEIGHT,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 16 + controlsLeft(true),
          paddingRight: 16 + controlsRight(true),
        }
      : { top: 16, left: 16, right: 16 }),
  } as const;
  return (
    <Dialog
      animation="none"
      onOpen={() => {
        if (alive) closeButton?.focus();
      }}
      onOpenChange={props.close}
      style={{ flex: 1 }}
    >
      <View
        accessibilityLabel={tr('Full screen image viewer')}
        style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: DARK.background }}
      >
        <View
          accessibilityLabel={tr('Image viewport')}
          focusable={false}
          pan={{ x, y }}
          pinch={{ scale }}
          onWheel={handleWheel}
          onPinchEnd={handlePinchEnd}
          onPress={handleViewportPress}
          onLayout={({ bounds: event }) => {
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
          {/* Trackpad pinches belong to onPinch alone; touchscreen pinches still reach the outer native binding. */}
          <View
            onPinch={handlePinch}
            style={{
              flex: 1,
              alignSelf: 'stretch',
              minWidth: 0,
              minHeight: 0,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <If when={viewport().width > 0 && viewport().height > 0}>
              <Each of={[image()]} key={(item) => item.uri}>
                {(item) => (
                  <Image
                    src={item().uri}
                    role="image"
                    accessibilityLabel={item().title}
                    onLoad={({ size: dimensions }) => {
                      if (!alive || image().uri !== item().uri) return;
                      const unknown = !size();
                      measured.set({ uri: item().uri, ...dimensions });
                      if (unknown) reset(Math.min(1, fit()));
                    }}
                    onError={(reason) => {
                      if (alive && image().uri === item().uri) error.set(reason.message);
                    }}
                    style={[
                      {
                        // An unmeasured image loads unseen at one point, then takes its own size.
                        width: size()?.width ?? 1,
                        height: size()?.height ?? 1,
                        opacity: size() ? 1 : 0,
                        flexShrink: 0,
                        transform: [{ translateX: x }, { translateY: y }, { scale }],
                      },
                      { pointerEvents: 'none', objectFit: 'contain' },
                    ]}
                  />
                )}
              </Each>
            </If>
          </View>
        </View>
        {/* Light mode on Windows/Linux draws dark window caption glyphs in the top-right corner; back them with chrome fill so they remain visible over the dark viewer. */}
        <If when={ownTitleBar && !isDark() && controlsRight(true) > 0}>
          <View
            style={[
              {
                position: 'absolute',
                top: 0,
                right: 0,
                width: controlsRight(true),
                height: TITLE_BAR_HEIGHT,
                backgroundColor: C.chrome,
                borderBottomLeftRadius: 8,
              },
              { pointerEvents: 'none' },
            ]}
          />
        </If>
        <View style={headerStyle}>
          <View style={[{ flex: 1, gap: 4 }, { pointerEvents: 'none' }]}>
            <Text style={[{ ...captionTextStyle, color: DARK.text }, { numberOfLines: 1 }]}>
              {image().title}
            </Text>
            <Text style={{ ...captionTextStyle, color: DARK.muted }}>
              {[
                ...(images().length > 1 ? [`${index() + 1} / ${images().length}`] : []),
                ...(size()
                  ? [`${size()!.width} × ${size()!.height}`, `${zoomPercent()}%`]
                  : error()
                    ? []
                    : [tr('Loading image…')]),
              ].join(' · ')}
            </Text>
            <If when={error()}>
              <Text style={{ ...captionTextStyle, color: DARK.danger }}>{error()}</Text>
            </If>
          </View>
          <Button
            ref={(node) => {
              closeButton = node;
            }}
            accessibilityLabel={tr('Close full screen image')}
            tooltip={textTooltip(() => tr('Close · Esc'))}
            onPress={props.close}
            style={{
              ...darkControlStyle,
              width: 36,
              paddingHorizontal: 10,
              backgroundColor: DARK.raised,
            }}
            hoverStyle={darkHoverStyle}
            focusStyle={darkFocusStyle}
          >
            <Icon name="close" color={DARK.text} />
          </Button>
        </View>
        <Each
          of={[
            { step: -1 as const, edge: { left: 16 }, icon: 'back' as const },
            { step: 1 as const, edge: { right: 16 }, icon: 'right' as const },
          ]}
          key={(item) => item.step}
        >
          {(item) => (
            <If when={images()[index() + item().step] !== undefined}>
              <View
                style={[
                  {
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    ...item().edge,
                    justifyContent: 'center',
                  },
                  { pointerEvents: 'box-none' },
                ]}
              >
                <Button
                  accessibilityLabel={item().step < 0 ? tr('Previous image') : tr('Next image')}
                  tooltip={textTooltip(() =>
                    item().step < 0 ? tr('Previous image · ←') : tr('Next image · →'),
                  )}
                  onPress={inputAction(go, item().step)}
                  style={{
                    ...darkControlStyle,
                    width: 36,
                    paddingHorizontal: 10,
                    backgroundColor: DARK.raised,
                  }}
                  hoverStyle={darkHoverStyle}
                  focusStyle={darkFocusStyle}
                >
                  <Icon name={item().icon} color={DARK.text} />
                </Button>
              </View>
            </If>
          )}
        </Each>
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
              backgroundColor: DARK.raised,
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
                  onPress={inputAction(control, { uri: image().uri, kind: item().kind })}
                  style={{ ...darkControlStyle, minWidth: 36, paddingHorizontal: 12 }}
                  hoverStyle={darkHoverStyle}
                  focusStyle={darkFocusStyle}
                >
                  <Text style={{ ...captionTextStyle, color: DARK.text }}>{item().caption()}</Text>
                </Button>
              )}
            </Each>
          </View>
        </View>
      </View>
    </Dialog>
  );
}

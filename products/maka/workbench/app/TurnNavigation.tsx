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

import type { HistoryRowAddress, HistoryOrder } from '../../../../packages/plugin-sdk/src/index.js';
import { textTooltip } from './ui';
import {
  Canvas,
  computed,
  effect,
  List,
  PanResponder,
  reduceMotion,
  signal,
  Text,
  View,
} from 'nsh';
import type { ListRef } from 'nsh';
import { Button, Tooltip } from 'nsh/base';
import { pixelRatio, platform, windowSize } from 'nsh';
import { host as nativeHost } from 'maka/host';

import { C, controlStyle, captionTextStyle, richTooltipStyle, tooltipTextStyle } from './ui';
import { Icon } from './Icon';
import { tr } from './locale';

// The pixel terminal uses a desktop renderer but still needs cell-sized targets.
const pixelTerminal = () => nativeHost.uiScaleSupported;
const markPitch = computed(() => {
  if (platform.idiom === 'terminal') return 16;
  if (!pixelTerminal()) return 10;
  // Cell input rounds by half a 16 / scale row; include the two-point stroke.
  pixelRatio();
  windowSize();
  return Math.max(24, 16 / nativeHost.uiScaleFactor + 2);
});
const fadeHeight = 40;
export const railWidth = () =>
  platform.idiom === 'terminal' ? 24 : pixelTerminal() ? markPitch() : 36;
const markerScale = [1, 20 / 26, 14 / 26, 10 / 26];

function TurnMark(props: {
  active: boolean;
  busy: boolean;
  distance: number;
  interacting: boolean;
}) {
  const active = () => props.active && !props.interacting;
  if (platform.idiom === 'terminal')
    return (
      <Text
        accessibilityElementsHidden
        style={[
          {
            width: railWidth(),
            height: markPitch(),
            lineHeight: markPitch(),
            textAlign: 'center',
            color: props.active ? C.text : C.line,
          },
          { pointerEvents: 'none' },
        ]}
      >
        {props.busy ? '◌' : props.active ? '●' : '━'}
      </Text>
    );
  if (pixelTerminal())
    return (
      <Canvas
        accessibilityElementsHidden
        style={[{ width: railWidth(), height: markPitch() }, { pointerEvents: 'none' }]}
        draw={(cx) => {
          const end = railWidth() - 1;
          const y = markPitch() / 2;
          cx.strokeStyle = props.active ? C.text : C.line;
          cx.lineWidth = 2;
          cx.lineCap = 'round';
          cx.beginPath();
          if (props.busy) cx.arc(end - 5, y, 3, 0, Math.PI * 2);
          else {
            cx.moveTo(end - (props.active ? 20 : 12), y);
            cx.lineTo(end, y);
          }
          cx.stroke();
        }}
      />
    );
  return (
    <View
      accessibilityElementsHidden
      style={[
        {
          width: railWidth(),
          height: markPitch(),
          alignItems: 'flex-end',
          justifyContent: 'center',
          paddingRight: 6,
        },
        { pointerEvents: 'none' },
      ]}
    >
      <If
        when={props.busy}
        else={
          <View
            class={
              reduceMotion()
                ? undefined
                : 'transition-transform duration-160 ease-[cubic-bezier(.18,.82,.24,1)]'
            }
            style={{
              width: 26,
              height: 2,
              backgroundColor: props.distance === 0 || active() ? C.text : C.secondary,
              opacity: props.distance === 0 ? 1 : active() ? 0.6 : 0.4,
              transformOrigin: 'right',
              transform: [{ scaleX: markerScale[props.distance] ?? 6 / 26 }],
            }}
          />
        }
      >
        <View
          style={{ width: 6, height: 6, borderRadius: 3, borderWidth: 1, borderColor: C.text }}
        />
      </If>
    </View>
  );
}

function RailFade(props: { bottom: boolean; height: number }) {
  return (
    <Canvas
      accessibilityElementsHidden
      style={[
        {
          position: 'absolute',
          left: 0,
          top: props.bottom ? undefined : 0,
          bottom: props.bottom ? 0 : undefined,
          width: railWidth(),
          height: props.height,
        },
        { pointerEvents: 'none' },
      ]}
      draw={(cx) => {
        const fade = cx.createLinearGradient(0, 0, 0, props.height);
        fade.addColorStop(0, props.bottom ? `${C.panel}00` : C.panel);
        fade.addColorStop(1, props.bottom ? C.panel : `${C.panel}00`);
        cx.fillStyle = fade;
        cx.fillRect(0, 0, railWidth(), props.height);
      }}
    />
  );
}

export type TurnNavigationItem = {
  turnKey: string;
  label: string;
  order: HistoryOrder;
  anchor:
    | { kind: 'loaded'; position: HistoryRowAddress }
    | {
        kind: 'landmark';
        through: number;
        position: HistoryRowAddress;
        lastPosition: HistoryRowAddress;
      };
};

function NavigationMark(props: {
  item(): TurnNavigationItem;
  active: boolean;
  busy: boolean;
  distance: number;
  interacting: boolean;
  select(item: TurnNavigationItem): void;
  hover(key: string | null): void;
  preview?(item: TurnNavigationItem): Promise<string>;
}) {
  const opened = signal(false);
  const previewText = signal('');
  effect(() => {
    const item = props.item();
    previewText.set('');
    if (!opened() || !props.preview || props.busy) return;
    let current = true;
    void props.preview(item).then(
      (text) => {
        if (current) previewText.set(text.trim());
      },
      (error) => console.warn('Could not load the anchor preview:', error),
    );
    return () => {
      current = false;
    };
  });
  return (
    <View
      onMouseEnter={() => props.hover(props.item().turnKey)}
      onMouseLeave={() => props.hover(null)}
      style={{ height: markPitch(), width: railWidth() }}
    >
      <Button
        accessibilityLabel={tr('Jump to turn: {label}', {
          label: props.item().label || tr('Recorded turn'),
        })}
        tooltip={
          <Tooltip
            placement="left"
            delay={150}
            offset={8}
            margin={16}
            onOpenChange={({ open }) => opened.set(open)}
            style={{
              ...richTooltipStyle(),
              width: Math.min(300, Math.max(0, windowSize().width - 32)),
              maxHeight: 100,
              pointerEvents: 'none',
            }}
          >
            <Text style={[{ ...tooltipTextStyle(), fontWeight: '500' }, { numberOfLines: 3 }]}>
              {previewText() || props.item().label || tr('Recorded turn')}
            </Text>
            <If when={props.busy}>
              <Text style={{ ...tooltipTextStyle(), color: C.muted }}>{tr('Navigating…')}</Text>
            </If>
          </Tooltip>
        }
        selected={props.active}
        onPress={() => props.select(props.item())}
        style={{
          height: markPitch(),
          width: railWidth(),
          borderRadius: 4,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        focusVisibleStyle={{ backgroundColor: C.cardRaised }}
      >
        <TurnMark
          active={props.active}
          busy={props.busy}
          distance={props.distance}
          interacting={props.interacting}
        />
      </Button>
    </View>
  );
}

/** Host landmarks and the loaded window retain one native, independently scrolling rail. */
export function TurnNavigation(props: {
  items(): readonly TurnNavigationItem[];
  active(): string | null;
  visible?(): ReadonlySet<string>;
  busy(): string | null;
  preview?(item: TurnNavigationItem): Promise<string>;
  navigate(item: TurnNavigationItem, mode: 'select' | 'scrub'): void;
  cancel(): void;
}) {
  const height = signal(0);
  const edgeFade = signal({ top: 0, bottom: 0 });
  const hovered = signal<string | null>(null);
  const scrubbed = signal<string | null>(null);
  let offset = 0;
  let pageY = 0;
  const contentHeight = computed(() => props.items().length * markPitch());
  const frameHeight = computed(() => {
    if (platform.idiom === 'terminal') {
      const available = Math.min(640, height() * 0.7);
      return Math.min(contentHeight(), Math.floor(available / markPitch()) * markPitch());
    }
    // The reference uses 70vh, measured against the whole window.
    // Leave room below the rail for its cancel button.
    return Math.min(
      contentHeight(),
      640,
      windowSize().height * 0.7,
      Math.max(0, height() - 2 * (markPitch() + 8)),
    );
  });
  const activeIndex = computed(() => {
    const active = props.active();
    const visible = props.visible?.();
    return props.items().findIndex((item) => item.turnKey === active || visible?.has(item.turnKey));
  });
  const hoveredIndex = computed(() => {
    const key = scrubbed() ?? hovered();
    return key === null ? -1 : props.items().findIndex((item) => item.turnKey === key);
  });
  let rail: ListRef | undefined;
  effect(() => {
    const index = activeIndex();
    const frame = frameHeight();
    const pitch = markPitch();
    if (!rail || index < 0 || frame < pitch || scrubbed() !== null) return;
    const start = index * pitch;
    const current = offset;
    if (start < current || start + pitch > current + frame)
      rail.scrollToIndex({
        index,
        viewPosition: start < current ? 0 : 1,
        animated: false,
        automatic: true,
      });
  });
  const scrubItem = (y: number) => {
    const local = Math.max(0, Math.min(frameHeight() - 1, y - pageY));
    const index = Math.floor((offset + local) / markPitch());
    return props.items()[Math.max(0, Math.min(index, props.items().length - 1))];
  };
  const scrub = (y: number) => {
    const item = scrubItem(y);
    if (!item || scrubbed() === item.turnKey) return;
    scrubbed.set(item.turnKey);
    props.navigate(item, 'scrub');
  };
  const pan = PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, { dx, dy }) =>
      Math.abs(dy) >= 4 && Math.abs(dy) >= Math.abs(dx),
    onPanResponderGrant: ({ pageY }) => {
      props.cancel();
      scrub(pageY);
    },
    onPanResponderMove: ({ pageY }) => scrub(pageY),
    onPanResponderRelease: (event) => {
      const item = scrubItem(event.pageY);
      if (item) props.navigate(item, 'select');
      scrubbed.set(null);
    },
    onPanResponderTerminate: () => scrubbed.set(null),
  });
  return (
    <View
      onLayout={({ bounds: frame }) => height.set(frame.size.height)}
      style={{ width: railWidth(), minHeight: 0, justifyContent: 'center' }}
    >
      <View
        style={{ width: railWidth(), height: frameHeight() }}
        {...(platform.idiom !== 'terminal' && !pixelTerminal() ? pan.panHandlers : {})}
      >
        <List
          ref={(node) => {
            rail = node;
          }}
          testID="turn-navigation"
          accessibilityLabel={tr('Turn navigation')}
          each={props.items()}
          keyExtractor={(item) => item.turnKey}
          estimatedItemSize={markPitch()}
          scrollbar={false}
          onLayout={async () => {
            const measured = await rail?.measure();
            if (measured) pageY = measured.pagePosition.y;
          }}
          onScroll={(event) => {
            offset = event.offset.y;
            edgeFade.set({
              top: Math.min(fadeHeight, Math.max(0, offset)),
              bottom: Math.min(
                fadeHeight,
                Math.max(0, event.contentSize.height - event.size.height - offset),
              ),
            });
          }}
          style={{ flex: 1, minHeight: 0 }}
        >
          {(item, index) => (
            <NavigationMark
              item={item}
              active={(props.visible?.().has(item().turnKey) ?? false) || activeIndex() === index()}
              busy={props.busy() === item().turnKey}
              preview={props.preview}
              distance={hoveredIndex() < 0 ? Infinity : Math.abs(hoveredIndex() - index())}
              interacting={hoveredIndex() >= 0}
              hover={(key) => hovered.set(key)}
              select={(item) => props.navigate(item, 'select')}
            />
          )}
        </List>
        <If when={platform.idiom !== 'terminal' && edgeFade().top > 0}>
          <RailFade bottom={false} height={edgeFade().top} />
        </If>
        <If when={platform.idiom !== 'terminal' && edgeFade().bottom > 0}>
          <RailFade bottom height={edgeFade().bottom} />
        </If>
        <If when={props.busy()}>
          <Button
            accessibilityLabel={tr('Cancel turn navigation')}
            tooltip={textTooltip(() => tr('Cancel navigation'))}
            onPress={props.cancel}
            style={{
              position: 'absolute',
              right: 0,
              top: '100%',
              marginTop: platform.idiom === 'terminal' ? 0 : 8,
              width: railWidth(),
              height: platform.idiom === 'terminal' ? 32 : markPitch(),
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: C.card,
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            focusStyle={{ backgroundColor: C.cardRaised }}
          >
            <Icon name="close" color={C.secondary} />
          </Button>
        </If>
      </View>
    </View>
  );
}

/**
 * `paused`: the view is already at the end but stopped following live output
 * (an expanded tool is being read), so the button resumes rather than descends.
 */
export function ReturnToLatest(props: { visible: boolean; paused?: boolean; activate(): void }) {
  return (
    <If when={props.visible}>
      <View
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 8,
            alignItems: 'center',
          },
          { pointerEvents: 'box-none' },
        ]}
      >
        <Button
          accessibilityLabel={props.paused ? tr('Resume following') : tr('Return to latest')}
          onPress={props.activate}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: C.cardRaised,
          }}
          hoverStyle={{ backgroundColor: C.card }}
          focusStyle={{ backgroundColor: C.accent }}
        >
          <If when={!props.paused}>
            <Icon name="latest" color={C.secondary} />
          </If>
          <Text style={{ ...captionTextStyle, color: C.text }}>
            {props.paused ? tr('Resume following') : tr('Latest')}
          </Text>
        </Button>
      </View>
    </If>
  );
}

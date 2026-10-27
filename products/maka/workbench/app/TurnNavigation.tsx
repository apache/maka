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
import { Canvas, computed, effect, inputAction, signal, Text, View, Overlay, List } from 'nsh';
import type { YNode } from 'nsh';
import { Button } from 'nsh/base';
import { platform, windowSize } from 'nsh';
import type { Position } from './history';
import { C, controlStyle, captionTextStyle } from './ui';
import { Icon } from './Icon';
import { tr } from './locale';
import { uiScale } from './uiScale';

// Cell input rounds by half a 16 / scale row; include the two-point stroke.
const markPitch = () => (platform.isTerminal ? 16 : Math.max(24, 16 / uiScale.factor() + 2));
const railInset = platform.isTerminal ? 0 : 6;
const railMargin = 32;
const railWidth = () => (platform.isTerminal ? 24 : markPitch());

function TurnMark(props: { active: boolean; busy: boolean; landmark: boolean }) {
  const color = () => (props.active ? C.text : C.line);
  if (platform.isTerminal)
    return (
      <Text
        accessibilityElementsHidden
        style={[
          {
            width: railWidth(),
            height: markPitch(),
            lineHeight: markPitch(),
            textAlign: 'center',
            color: color(),
          },
          { pointerEvents: 'none' },
        ]}
      >
        {props.busy ? '◌' : props.active ? '●' : '━'}
      </Text>
    );
  return (
    <Canvas
      accessibilityElementsHidden
      style={[{ width: railWidth(), height: markPitch() }, { pointerEvents: 'none' }]}
      draw={(cx) => {
        cx.strokeStyle = color();
        cx.lineWidth = 2;
        cx.lineCap = 'round';
        cx.beginPath();
        if (props.busy) cx.arc(railWidth() - 6, markPitch() / 2, 3, 0, Math.PI * 2);
        else {
          const width = props.active ? 20 : props.landmark ? 8 : 12;
          cx.moveTo(railWidth() - width - 1, markPitch() / 2);
          cx.lineTo(railWidth() - 1, markPitch() / 2);
        }
        cx.stroke();
      }}
    />
  );
}

function RailFade(props: { bottom: boolean }) {
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
          height: 24,
        },
        { pointerEvents: 'none' },
      ]}
      draw={(cx) => {
        const fade = cx.createLinearGradient(0, 0, 0, 24);
        fade.addColorStop(0, props.bottom ? `${C.background}00` : C.background);
        fade.addColorStop(1, props.bottom ? C.background : `${C.background}00`);
        cx.fillStyle = fade;
        cx.fillRect(0, 0, railWidth(), 24);
      }}
    />
  );
}

export type TurnNavigationItem = {
  turnId: string;
  label: string;
  anchor:
    | { kind: 'loaded'; position: Position }
    | {
        kind: 'landmark';
        through: number;
        position: Position;
        lastPosition: Position;
      };
};

function NavigationMark(props: {
  item(): TurnNavigationItem;
  active: boolean;
  busy: boolean;
  navigate(item: TurnNavigationItem): void;
}) {
  return (
    <Button
      accessibilityLabel={tr('Jump to turn: {label}', {
        label: props.item().label || tr('Recorded turn'),
      })}
      tooltip={
        <Overlay
          placement="left"
          hintDelay={0}
          offset={12}
          margin={16}
          style={{
            width: Math.min(300, Math.max(0, windowSize().width - 32)),
            maxHeight: 100,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: C.surface,
            borderWidth: 1,
            borderColor: C.line,
            pointerEvents: 'none',
          }}
        >
          <Text
            style={[
              { ...captionTextStyle, color: C.text, fontWeight: '500' },
              { numberOfLines: 3 },
            ]}
          >
            {props.item().label || tr('Recorded turn')}
          </Text>
          <If when={props.busy}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Navigating…')}</Text>
          </If>
        </Overlay>
      }
      selected={props.active}
      onPress={inputAction(props.navigate, props.item())}
      style={{
        height: markPitch(),
        width: railWidth(),
        borderRadius: 4,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      hoverStyle={{ backgroundColor: C.surface }}
      focusStyle={{ backgroundColor: C.raised }}
    >
      <TurnMark
        active={props.active}
        busy={props.busy}
        landmark={props.item().anchor.kind === 'landmark'}
      />
    </Button>
  );
}

/** Host landmarks and the loaded window retain one native, independently scrolling rail. */
export function TurnNavigation(props: {
  items(): readonly TurnNavigationItem[];
  active(): string | null;
  busy(): string | null;
  navigate(item: TurnNavigationItem): void;
  cancel(): void;
}) {
  const height = signal(0);
  const offset = signal(0);
  const contentHeight = computed(() => props.items().length * markPitch() + railInset * 2);
  const frameHeight = computed(() => {
    // Bound the instrument's geometry, never its item count or history source.
    const available = Math.min(420, Math.max(0, height() - railMargin * 2));
    return Math.min(
      contentHeight(),
      platform.isTerminal ? Math.floor(available / markPitch()) * markPitch() : available,
    );
  });
  const activeIndex = computed(() => {
    const active = props.active();
    return props.items().findIndex((item) => item.turnId === active);
  });
  let rail: YNode | undefined;
  const followActive = () => {
    const index = activeIndex();
    if (rail && props.active() !== null && index >= 0)
      rail.scrollToIndex({
        index,
        viewPosition: 0.5,
        animated: false,
        automatic: true,
      });
  };
  effect(() => {
    // A splice may retain the same active index: refresh its one native target too.
    props.items();
    frameHeight();
    followActive();
  });
  return (
    <View
      onLayout={(frame) => height.set(frame.size.height)}
      style={{ width: railWidth(), minHeight: 0, justifyContent: 'center' }}
    >
      <View style={{ width: railWidth(), height: frameHeight() }}>
        <List
          ref={rail}
          testID="turn-navigation"
          accessibilityLabel={tr('Turn navigation')}
          each={props.items()}
          keyExtractor={(item) => item.turnId}
          estimatedItemSize={markPitch()}
          scrollbar={false}
          contentStyle={{ paddingVertical: railInset }}
          onScrollIntent={() => props.cancel()}
          onScroll={(event) => offset.set(event.offset.y)}
          style={{ flex: 1, minHeight: 0 }}
        >
          {(item) => (
            <NavigationMark
              item={item}
              active={props.active() === item().turnId}
              busy={props.busy() === item().turnId}
              navigate={props.navigate}
            />
          )}
        </List>
        <If when={!platform.isTerminal && offset() > 0}>
          <RailFade bottom={false} />
        </If>
        <If when={!platform.isTerminal && offset() + frameHeight() < contentHeight()}>
          <RailFade bottom />
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
              marginTop: platform.isTerminal ? 0 : 8,
              width: railWidth(),
              height: platform.isTerminal ? 32 : markPitch(),
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: C.surface,
            }}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={{ backgroundColor: C.raised }}
          >
            <Icon name="close" color={C.secondary} />
          </Button>
        </If>
      </View>
    </View>
  );
}

export function ReturnToLatest(props: { visible: boolean; activate(): void }) {
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
          accessibilityLabel={tr('Return to latest')}
          onPress={props.activate}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: C.raised,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.accent }}
        >
          <Icon name="latest" color={C.secondary} />
          <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Latest')}</Text>
        </Button>
      </View>
    </If>
  );
}

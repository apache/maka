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
import { Canvas, computed, effect, inputAction, signal, Text, View, List } from 'nsh';
import type { ListRef } from 'nsh';
import { Button, Tooltip } from 'nsh/base';
import { reduceMotion, platform, windowSize } from 'nsh';
import type { Position } from './history';
import { C, controlStyle, captionTextStyle, isDark } from './ui';
import { Icon } from './Icon';
import { tr } from './locale';

const markPitch = () => (platform.idiom === 'terminal' ? 16 : 12);
const railInset = platform.idiom === 'terminal' ? 0 : 6;
const railMargin = 32;
export const railWidth = () => (platform.idiom === 'terminal' ? 24 : 26);

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
        fade.addColorStop(0, props.bottom ? `${C.panel}00` : C.panel);
        fade.addColorStop(1, props.bottom ? C.panel : `${C.panel}00`);
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
  distance: number;
  preview(): string;
  hover(): void;
  leave(): void;
  busy: boolean;
  navigate(item: TurnNavigationItem): void;
}) {
  return (
    <View onMouseEnter={props.hover} onMouseLeave={props.leave}>
      <Button
        accessibilityLabel={tr('Jump to turn: {label}', {
          label: props.item().label || tr('Recorded turn'),
        })}
        tooltip={
          <Tooltip
            placement="right"
            delay={0}
            offset={12}
            margin={16}
            style={{
              width: Math.min(248, Math.max(0, windowSize().width - 32)),
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
                { numberOfLines: 1 },
              ]}
            >
              {props.item().label || tr('Recorded turn')}
            </Text>
            <If when={props.preview()}>
              <Text style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 2 }]}>
                {props.preview()}
              </Text>
            </If>
            <If when={props.busy}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Navigating…')}</Text>
            </If>
          </Tooltip>
        }
        selected={props.active}
        onPress={inputAction(props.navigate, props.item())}
        style={{
          height: markPitch(),
          width: railWidth(),
          alignItems: 'flex-start',
          paddingLeft: platform.idiom === 'terminal' ? 0 : 7,
          justifyContent: 'center',
        }}
        focusStyle={{ backgroundColor: C.raised }}
      >
        <If when={platform.idiom === 'terminal'}>
          <Text style={{ color: props.active ? C.text : C.line }}>
            {props.busy ? '◌' : props.active ? '●' : '━'}
          </Text>
        </If>
        <If when={platform.idiom !== 'terminal'}>
          <View
            style={{
              height: 2,
              width: [19, 14, 9][props.distance] ?? 6,
              borderRadius: 1,
              backgroundColor: isDark()
                ? props.active || props.distance === 0
                  ? '#ffffff'
                  : C.muted
                : props.distance === 0
                  ? '#383b43'
                  : props.active
                    ? '#72757d'
                    : '#b3b5ba',
              transitionProperty: 'width',
              transitionDuration: reduceMotion() ? 0 : 150,
              transitionTimingFunction: 'ease-out',
            }}
          />
        </If>
      </Button>
    </View>
  );
}

/** Host landmarks and the loaded window retain one native, independently scrolling rail. */
export function TurnNavigation(props: {
  visible?(): ReadonlySet<string>;
  preview?(turnId: string): string;
  items(): readonly TurnNavigationItem[];
  active(): string | null;
  busy(): string | null;
  navigate(item: TurnNavigationItem): void;
  cancel(): void;
}) {
  const hovered = signal<string | null>(null);
  const hoveredIndex = computed(() => props.items().findIndex((item) => item.turnId === hovered()));
  const height = signal(0);
  const offset = signal(0);
  const contentHeight = computed(() => props.items().length * markPitch() + railInset * 2);
  const frameHeight = computed(() => {
    // Bound the instrument's geometry, never its item count or history source.
    const available = Math.min(420, Math.max(0, height() - railMargin * 2));
    return Math.min(
      contentHeight(),
      platform.idiom === 'terminal' ? Math.floor(available / markPitch()) * markPitch() : available,
    );
  });
  const activeIndex = computed(() => {
    const active = props.active();
    return props.items().findIndex((item) => item.turnId === active);
  });
  let rail: ListRef | undefined;
  const followActive = () => {
    const index = activeIndex();
    if (
      rail &&
      contentHeight() > frameHeight() &&
      frameHeight() > 0 &&
      props.active() !== null &&
      index >= 0
    )
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
      onLayout={({ bounds: frame }) => height.set(frame.size.height)}
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
          {(item, index) => (
            <NavigationMark
              item={item}
              active={
                platform.idiom === 'terminal'
                  ? props.active() === item().turnId
                  : (props.visible?.().has(item().turnId) ?? props.active() === item().turnId)
              }
              distance={hoveredIndex() < 0 ? Infinity : Math.abs(index() - hoveredIndex())}
              preview={() => props.preview?.(item().turnId) ?? ''}
              hover={() => hovered.set(item().turnId)}
              leave={() => {
                if (hovered() === item().turnId) hovered.set(null);
              }}
              busy={props.busy() === item().turnId}
              navigate={props.navigate}
            />
          )}
        </List>
        <If when={platform.idiom !== 'terminal' && offset() > 0}>
          <RailFade bottom={false} />
        </If>
        <If when={platform.idiom !== 'terminal' && offset() + frameHeight() < contentHeight()}>
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

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

import {
  Canvas,
  cleanup,
  computed,
  effect,
  List,
  platform,
  signal,
  Text,
  untracked,
  View,
  windowSize,
  type ListRef,
} from 'nsh';
import { Button, Popover, Tooltip } from 'nsh/base';
import { tr } from './locale';
import type { TocHeadingItem, TocLayoutMode } from './markdownTocModel';
import { C, captionTextStyle, floatingStyle, tooltipStyle, tooltipTextStyle } from './ui';

const ROW_HEIGHT = platform.idiom === 'terminal' ? 16 : 26;
const FADE_HEIGHT = 24;
const RAIL_WIDTH = 20;
const MAX_RAIL_MARKS = 24;
const RAIL_HOVER_CLOSE_MS = 160;
const MARK_WIDTHS = [10, 7, 5] as const;

function TocFade(props: {
  readonly bottom?: boolean;
  readonly height: number;
  readonly width: number;
  readonly surface: () => string;
}) {
  return (
    <Canvas
      accessibilityElementsHidden
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          top: props.bottom ? undefined : 0,
          bottom: props.bottom ? 0 : undefined,
          height: props.height,
        },
        { pointerEvents: 'none' },
      ]}
      draw={(cx) => {
        const bg = props.surface();
        const fade = cx.createLinearGradient(0, 0, 0, props.height);
        fade.addColorStop(0, props.bottom ? `${bg}00` : bg);
        fade.addColorStop(1, props.bottom ? bg : `${bg}00`);
        cx.fillStyle = fade;
        cx.fillRect(0, 0, props.width, props.height);
      }}
    />
  );
}

function TocHeadingList(props: {
  readonly turnKey: () => string | null;
  readonly items: () => readonly TocHeadingItem[];
  readonly active: () => string | null;
  readonly baseLevel: () => number;
  readonly width: () => number;
  readonly availableHeight: () => number;
  readonly floating: boolean;
  readonly select: (item: TocHeadingItem) => void;
}) {
  const scrollOffset = signal(0);
  const listRef = signal<ListRef | undefined>(undefined);
  let hovered = false;

  const contentHeight = computed(() => props.items().length * ROW_HEIGHT);
  const frameHeight = computed(() => {
    const maxBudget = Math.min(
      480,
      windowSize().height * 0.65,
      Math.max(0, props.availableHeight() - (props.floating ? 36 : 24)),
    );
    if (platform.idiom === 'terminal') {
      return Math.min(contentHeight(), Math.floor(maxBudget / ROW_HEIGHT) * ROW_HEIGHT);
    }
    return Math.min(contentHeight(), maxBudget);
  });

  const edgeFade = computed(() => {
    const content = contentHeight();
    const frame = frameHeight();
    if (content <= frame + 1) return { top: 0, bottom: 0 };
    const offset = Math.max(0, Math.min(scrollOffset(), content - frame));
    return {
      top: Math.min(FADE_HEIGHT, offset),
      bottom: Math.min(FADE_HEIGHT, Math.max(0, content - frame - offset)),
    };
  });

  const activeIndex = computed(() => {
    const id = props.active();
    return id === null ? -1 : props.items().findIndex((item) => item.id === id);
  });

  let syncedTurn: string | null = null;
  effect(() => {
    const turn = props.turnKey();
    const list = listRef();
    const index = activeIndex();
    const frame = frameHeight();
    if (!list || index < 0 || frame < ROW_HEIGHT) return;
    const turnChanged = turn !== syncedTurn;
    syncedTurn = turn;
    if (hovered && !turnChanged) return;
    const start = index * ROW_HEIGHT;
    const current = untracked(scrollOffset);
    if (turnChanged || start < current || start + ROW_HEIGHT > current + frame) {
      list.scrollToIndex({
        index,
        viewPosition: start <= current ? 0 : 1,
        animated: false,
      });
    }
  });

  const surface = () => (props.floating ? C.floating : C.panel);

  return (
    <View
      onMouseEnter={() => {
        hovered = true;
      }}
      onMouseLeave={() => {
        hovered = false;
      }}
      style={{ width: props.width(), height: frameHeight(), minHeight: 0 }}
    >
      <List
        ref={(node) => {
          listRef.set(node);
        }}
        testID="markdown-toc-list"
        accessibilityLabel={tr('Table of contents')}
        each={props.items()}
        keyExtractor={(item) => item.id}
        estimatedItemSize={ROW_HEIGHT}
        scrollbar={false}
        onScroll={(event) => scrollOffset.set(event.offset.y)}
        style={{ flex: 1, minHeight: 0 }}
      >
        {(item) => {
          const isActive = () => props.active() === item().id;
          const depth = () => Math.min(3, Math.max(0, item().level - props.baseLevel()));
          return (
            <Button
              accessibilityLabel={tr('Jump to section: {title}', { title: item().title })}
              selected={isActive()}
              tooltip={
                platform.idiom === 'terminal' ? undefined : (
                  <Tooltip
                    placement="right"
                    delay={350}
                    offset={8}
                    margin={16}
                    style={tooltipStyle()}
                  >
                    <Text style={tooltipTextStyle()}>{item().title}</Text>
                  </Tooltip>
                )
              }
              onPress={() => props.select(item())}
              style={{
                width: '100%',
                height: ROW_HEIGHT,
                borderRadius: platform.idiom === 'terminal' ? 0 : 6,
                paddingLeft: 8 + depth() * 10,
                paddingRight: 8,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                justifyContent: 'flex-start',
              }}
              hoverStyle={{ backgroundColor: props.floating ? C.floatingRaised : C.card }}
              focusVisibleStyle={{
                backgroundColor: props.floating ? C.floatingRaised : C.cardRaised,
              }}
            >
              <If when={platform.idiom !== 'terminal'}>
                <View
                  accessibilityElementsHidden
                  style={{
                    width: 2,
                    height: 12,
                    borderRadius: 1,
                    flexShrink: 0,
                    backgroundColor: isActive() ? C.text : C.line,
                    opacity: isActive() ? 1 : 0.45,
                  }}
                />
              </If>
              <Text
                style={[
                  {
                    ...captionTextStyle,
                    flex: 1,
                    minWidth: 0,
                    color: isActive() ? C.text : C.muted,
                    fontWeight: isActive() ? '500' : '400',
                  },
                  { numberOfLines: 1, textOverflow: 'ellipsis' },
                ]}
              >
                {item().title}
              </Text>
            </Button>
          );
        }}
      </List>
      <If when={platform.idiom !== 'terminal' && edgeFade().top > 0}>
        <TocFade height={edgeFade().top} width={props.width()} surface={surface} />
      </If>
      <If when={platform.idiom !== 'terminal' && edgeFade().bottom > 0}>
        <TocFade bottom height={edgeFade().bottom} width={props.width()} surface={surface} />
      </If>
    </View>
  );
}

function CompactTocRail(props: {
  readonly turnKey: () => string | null;
  readonly items: () => readonly TocHeadingItem[];
  readonly active: () => string | null;
  readonly baseLevel: () => number;
  readonly availableHeight: () => number;
  readonly railLeft: () => number;
  readonly popoverWidth: () => number;
  readonly select: (item: TocHeadingItem) => void;
}) {
  const mode = signal<'closed' | 'hover' | 'pinned'>('closed');
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const clearClose = () => {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  };
  const scheduleHoverClose = () => {
    clearClose();
    if (mode() !== 'hover') return;
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (mode() === 'hover') mode.set('closed');
    }, RAIL_HOVER_CLOSE_MS);
  };
  cleanup(clearClose);

  const visibleMarks = computed(() => {
    const all = props.items();
    if (all.length <= MAX_RAIL_MARKS) return all;
    const activeIdx = Math.max(
      0,
      all.findIndex((item) => item.id === props.active()),
    );
    const half = Math.floor(MAX_RAIL_MARKS / 2);
    const start = Math.max(0, Math.min(all.length - MAX_RAIL_MARKS, activeIdx - half));
    return all.slice(start, start + MAX_RAIL_MARKS);
  });

  return (
    <View
      style={[
        {
          marginLeft: props.railLeft(),
          justifyContent: 'center',
        },
        { pointerEvents: 'box-none' },
      ]}
    >
      <Popover
        open={mode() !== 'closed'}
        onOpenChange={({ reason }) => {
          if (reason !== 'triggerPress') return;
          clearClose();
          mode.set(mode() === 'pinned' ? 'closed' : 'pinned');
        }}
        // Pinning a hover preview keeps it open despite the trigger's close request.
        // A subsequent dismissal is a distinct gesture, even with the same requested value.
        onCancel={() => {
          clearClose();
          mode.set('closed');
        }}
        closeOnEscape
        closeOnPressOutside
        placement="right"
        align="center"
        offset={8}
        popupStyle={{ ...floatingStyle(), padding: 6 }}
        trigger={
          <Button
            testID="markdown-toc-rail"
            accessibilityLabel={tr('Table of contents')}
            selected={mode() === 'pinned'}
            onMouseEnter={() => {
              clearClose();
              if (mode() === 'closed') mode.set('hover');
            }}
            onMouseLeave={scheduleHoverClose}
            style={{
              width: RAIL_WIDTH,
              paddingVertical: 8,
              paddingHorizontal: 4,
              borderRadius: 6,
              alignItems: 'flex-start',
              justifyContent: 'center',
              gap: 6,
            }}
            hoverStyle={{ backgroundColor: C.card }}
            focusVisibleStyle={{ backgroundColor: C.cardRaised }}
          >
            <Each of={visibleMarks()} key={(item) => item.id}>
              {(item) => {
                const isActive = () => props.active() === item().id;
                const width = () => {
                  const depth = Math.min(2, Math.max(0, item().level - props.baseLevel()));
                  return MARK_WIDTHS[depth] ?? 5;
                };
                return (
                  <View
                    accessibilityElementsHidden
                    style={[
                      {
                        width: isActive() ? 12 : width(),
                        height: 2,
                        borderRadius: 1,
                        backgroundColor: isActive() ? C.text : C.secondary,
                        opacity: isActive() ? 1 : 0.38,
                      },
                      { pointerEvents: 'none' },
                    ]}
                  />
                );
              }}
            </Each>
          </Button>
        }
      >
        <View
          testID="markdown-toc-popover"
          onMouseEnter={clearClose}
          onMouseLeave={scheduleHoverClose}
        >
          <TocHeadingList
            turnKey={props.turnKey}
            items={props.items}
            active={props.active}
            baseLevel={props.baseLevel}
            width={() => props.popoverWidth() - 12}
            availableHeight={props.availableHeight}
            floating
            select={(item) => {
              clearClose();
              mode.set('closed');
              props.select(item);
            }}
          />
        </View>
      </Popover>
    </View>
  );
}

export function MarkdownToc(props: {
  readonly turnKey: () => string | null;
  readonly items: () => readonly TocHeadingItem[];
  readonly active: () => string | null;
  readonly mode: () => TocLayoutMode;
  readonly select: (item: TocHeadingItem) => void;
}) {
  const height = signal(0);
  const baseLevel = computed(() => {
    let min = 6;
    for (const item of props.items()) {
      if (item.level < min) min = item.level;
    }
    return min;
  });

  return (
    <If when={props.items().length > 0 && props.mode().kind !== 'hidden'}>
      <View
        testID="markdown-toc"
        onLayout={({ bounds }) => height.set(bounds.size.height)}
        style={[{ height: '100%', justifyContent: 'center' }, { pointerEvents: 'box-none' }]}
      >
        <If
          when={props.mode().kind === 'docked'}
          else={
            <CompactTocRail
              turnKey={props.turnKey}
              items={props.items}
              active={props.active}
              baseLevel={baseLevel}
              availableHeight={height}
              railLeft={() => {
                const m = props.mode();
                return m.kind === 'compact' ? m.railLeft : 4;
              }}
              popoverWidth={() => {
                const m = props.mode();
                return m.kind === 'compact' ? m.popoverWidth : 220;
              }}
              select={props.select}
            />
          }
        >
          <View
            style={{
              marginLeft: (() => {
                const m = props.mode();
                return m.kind === 'docked' ? m.left : 12;
              })(),
            }}
          >
            <TocHeadingList
              turnKey={props.turnKey}
              items={props.items}
              active={props.active}
              baseLevel={baseLevel}
              width={() => {
                const m = props.mode();
                return m.kind === 'docked' ? m.width : 180;
              }}
              availableHeight={height}
              floating={false}
              select={props.select}
            />
          </View>
        </If>
      </View>
    </If>
  );
}

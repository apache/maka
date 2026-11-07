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

import { tr } from './locale';
import { Canvas, cleanup, effect, platform, Text, untracked, View, List, type ListRef } from 'nsh';
import type { ComposerChecklistSource } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { C, bodyTextStyle } from './ui';
import { Icon } from './Icon';
import { ChoiceIndicator } from './ChoiceIndicator';
import { createChecklistState } from './checklistState';

const itemHeight = bodyTextStyle.lineHeight + 16;

// How far the list has come: a pie filling clockwise from twelve o'clock.
function ChecklistProgress(props: { share: () => number }) {
  return (
    <Canvas
      accessibilityElementsHidden
      style={[{ width: 16, height: 16, flexShrink: 0 }, { pointerEvents: 'none' }]}
      draw={(cx) => {
        cx.lineWidth = 1.5;
        cx.strokeStyle = C.muted;
        cx.beginPath();
        cx.arc(8, 8, 6.25, 0, Math.PI * 2);
        cx.stroke();
        if (props.share() <= 0) return;
        const start = -Math.PI / 2;
        cx.fillStyle = C.accent;
        cx.beginPath();
        cx.moveTo(8, 8);
        cx.arc(8, 8, 4, start, start + props.share() * Math.PI * 2);
        cx.closePath();
        cx.fill();
      }}
    />
  );
}

export function createChecklist(
  source: ComposerChecklistSource,
  height: () => number,
  sessionId: string,
) {
  const state = createChecklistState(source, sessionId);
  const { snapshot, items, error, complete } = state;
  return {
    shown: state.shown,
    hide: state.hide,
    mark: () => (
      <If
        when={!error() && !complete()}
        else={
          <Icon
            name={error() ? 'statusError' : 'statusSuccess'}
            color={error() ? C.warning : C.success}
          />
        }
      >
        {platform.isTerminal ? (
          <Icon name="activity" color={C.accent} />
        ) : (
          <ChecklistProgress
            share={() => (snapshot()?.total ? snapshot()!.completed / snapshot()!.total : 0)}
          />
        )}
      </If>
    ),
    summary: () => (snapshot()?.total ? `${snapshot()!.completed}/${snapshot()!.total}` : ''),
    preview: () =>
      error() ||
      snapshot()?.current?.content ||
      (snapshot()?.completed === snapshot()?.total
        ? tr('All items complete')
        : tr('No active item')),
    problem: () => !!error(),
    content: () => {
      // Open at the active item without remounting the list when more pages arrive.
      const initialActive = untracked(() => snapshot()?.activeIndex ?? -1);
      const initialLoaded = untracked(() => items().length);
      const initialScrollIndex =
        initialActive >= 0 && initialActive < initialLoaded ? initialActive : 0;
      let list: ListRef | undefined;
      let open = true;
      let currentDigest = untracked(() => snapshot()?.digest ?? null);
      const close = state.open();
      cleanup(() => {
        open = false;
        close();
      });
      if (initialActive >= initialLoaded) {
        void untracked(() => state.reveal(() => open)).then((index) => {
          if (open && index > 0) list?.scrollToIndex({ index, animated: false });
        });
      }
      // If a brand-new checklist replaces the open one, jump to its active item.
      effect(() => {
        const digest = snapshot()?.digest ?? null;
        if (digest === currentDigest) return;
        currentDigest = digest;
        if (digest === null) return;
        const nextIndex = snapshot()?.activeIndex ?? -1;
        if (nextIndex >= 0 && nextIndex < items().length) {
          list?.scrollToIndex({ index: nextIndex, animated: false });
        }
      });
      return (
        <View style={{ minHeight: 0, flexShrink: 1 }}>
          <If when={items().length > 0}>
            <List
              ref={(node) => {
                list = node;
              }}
              each={items()}
              onLoadMore={() => void state.loadMore()}
              estimatedItemSize={itemHeight}
              initialScrollIndex={initialScrollIndex}
              keyExtractor={(_, index) => String(index)}
              style={{
                minHeight: 0,
                flexShrink: 1,
                height: Math.min(
                  items().length * itemHeight,
                  error() ? Math.max(itemHeight, height() - itemHeight) : height(),
                ),
              }}
            >
              {(item) => (
                <View
                  style={{
                    minHeight: itemHeight,
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    gap: 8,
                  }}
                >
                  {/* As tall as the first line, so the mark centres on it. */}
                  <View style={{ height: bodyTextStyle.lineHeight, justifyContent: 'center' }}>
                    <If
                      when={item().status === 'in_progress'}
                      else={
                        <ChoiceIndicator kind="checkbox" checked={item().status === 'completed'} />
                      }
                    >
                      <Icon name="activity" color={C.accent} />
                    </If>
                  </View>
                  <Text
                    style={[
                      {
                        ...bodyTextStyle,
                        flex: 1,
                        color:
                          item().status === 'in_progress'
                            ? C.accent
                            : item().status === 'completed'
                              ? C.muted
                              : C.secondary,
                      },
                      { userSelect: 'text' },
                    ]}
                  >
                    {item().content}
                  </Text>
                </View>
              )}
            </List>
          </If>
          <If when={error()}>
            <Text
              style={[
                { ...bodyTextStyle, paddingHorizontal: 16, paddingVertical: 8, color: C.danger },
                { userSelect: 'text' },
              ]}
            >
              {error()}
            </Text>
          </If>
        </View>
      );
    },
  };
}

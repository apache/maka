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

import { createText, UiError, errorText } from './text';
import { tr } from './locale';
import {
  batch,
  cleanup,
  createAnimatedValue,
  inputAction,
  LayoutAnimation,
  reduceMotion,
  signal,
  Text,
  View,
  List,
} from 'nsh';
import { Button } from 'nsh/base';
import { windowSize } from 'nsh';
import { host } from './host';
import type { Subscription } from './history';
import type { AgentChecklist, AgentTodoItem } from '../../../../packages/plugin-sdk/src/index.js';
import { C, bodyTextStyle, captionTextStyle, controlStyle } from './ui';
import { Icon } from './Icon';
import { ChoiceIndicator } from './ChoiceIndicator';

/**
 * The next layout change springs: the dock and the column above it settle
 * with one small overshoot instead of jumping.
 */
const springNext = () => {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext({
    duration: 420,
    create: { type: 'easeOut', property: 'opacity', duration: 160 },
    update: { type: 'spring', springDamping: 0.6 },
    delete: { type: 'easeOut', property: 'opacity', duration: 120 },
  });
};

/**
 * The conversation's todo dock. On the desktop, `tuck` is the corner radius of
 * the composer below: the dock takes its top corners and slides under the
 * composer by as much, so the two read as one shape.
 */
export function Checklist(props: { sessionId: string; tuck?: number }) {
  const sessionId = props.sessionId;
  // How far the dock sits below its place: it rises from behind the composer
  // when it appears during the conversation, not when the conversation opens.
  const rise = createAnimatedValue(0);
  let riseOnMount = false;
  const snapshot = signal<AgentChecklist | null>(null);
  const items = signal<AgentTodoItem[]>([]);
  const nextOffset = signal<AgentChecklist['nextOffset']>(null);
  const expanded = signal(false);
  const loading = signal(false);
  const error = createText();
  let alive = true;
  let generation = 0;
  let stream: Subscription | null = null;
  const setExpanded = (action: { sessionId: string; open: boolean }) => {
    const page = snapshot();
    if (!alive || action.sessionId !== sessionId || !page?.enabled || page.total === 0) return;
    if (props.tuck !== undefined) springNext();
    expanded.set(action.open);
  };
  const loadMore = async () => {
    const page = snapshot();
    const offset = nextOffset();
    if (!alive || loading() || !page || offset === null || offset === undefined) return;
    const currentGeneration = generation;
    loading.set(true);
    error.set('');
    try {
      const next: AgentChecklist = await host.query('agent', 'checklist', { sessionId, offset });
      // A replacement invalidates every previously loaded page. Never stitch
      // pages from two checklist revisions; the watch supplies the new head.
      if (!alive || currentGeneration !== generation || next.revision !== page.revision) return;
      batch(() => {
        items.set([...items(), ...next.items]);
        nextOffset.set(next.nextOffset);
      });
    } catch (reason) {
      if (alive && currentGeneration === generation) error.set(errorText(reason));
    } finally {
      if (alive && currentGeneration === generation) loading.set(false);
    }
  };
  cleanup(() => {
    alive = false;
    const previous = stream;
    stream = null;
    if (previous) void previous.close().catch(() => {});
  });
  void (async () => {
    const opened = await host.subscribe('agent', 'watchChecklist', { sessionId, offset: 0 });
    if (!alive) {
      await opened.close();
      return;
    }
    stream = opened;
    try {
      for (;;) {
        const page: AgentChecklist | null = await opened.next();
        if (!alive) return;
        if (page === null) throw new UiError('Checklist updates ended. Reopen the conversation.');
        if (snapshot() && page.revision === snapshot()!.revision) continue;
        generation += 1;
        const shown = (value: AgentChecklist | null) => !!value?.enabled && value.total > 0;
        const before = snapshot();
        if (props.tuck !== undefined && before !== null && shown(page) !== shown(before)) {
          springNext();
          riseOnMount = shown(page);
        }
        batch(() => {
          snapshot.set(page);
          items.set(page.items);
          nextOffset.set(page.nextOffset);
          loading.set(false);
          error.set('');
        });
      }
    } finally {
      if (stream === opened) {
        stream = null;
        await opened.close();
      }
    }
  })().catch((reason) => {
    if (alive) error.set(errorText(reason));
  });
  return (
    <If when={snapshot()?.enabled && snapshot()!.total > 0}>
      <View
        accessibilityLabel={tr('Conversation todo dock')}
        ref={() => {
          if (!riseOnMount || reduceMotion()) return;
          riseOnMount = false;
          rise.set(48);
          void rise.spring(0, { stiffness: 360, damping: 17 });
        }}
        style={
          props.tuck === undefined
            ? { backgroundColor: C.surface, borderRadius: 8 }
            : {
                backgroundColor: C.surface,
                borderWidth: 1,
                borderColor: C.line,
                borderTopLeftRadius: props.tuck,
                borderTopRightRadius: props.tuck,
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
                overflow: 'hidden',
                paddingBottom: props.tuck,
                marginBottom: -props.tuck,
                transform: [{ translateY: rise }],
              }
        }
      >
        <Button
          accessibilityLabel={tr('Toggle conversation todo')}
          selected={expanded()}
          onPress={inputAction(setExpanded, { sessionId, open: !expanded() })}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            ...(props.tuck === undefined ? {} : { borderRadius: 0, paddingHorizontal: 16 }),
          }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={{ backgroundColor: C.line }}
          activeStyle={{ backgroundColor: C.raised }}
        >
          <Icon name={expanded() ? 'down' : 'right'} color={C.secondary} />
          <Text style={{ ...captionTextStyle, color: C.text }}>
            {tr('Todo')} {snapshot()!.completed}/{snapshot()!.total}
          </Text>
          <Text style={[{ ...captionTextStyle, flex: 1, color: C.muted }, { numberOfLines: 1 }]}>
            {snapshot()!.current?.content ??
              (snapshot()!.completed === snapshot()!.total
                ? tr('All items complete')
                : tr('No active item'))}
          </Text>
        </Button>
        <If when={expanded()}>
          <List
            each={items()}
            onLoadMore={() => void loadMore()}
            estimatedItemSize={32}
            keyExtractor={(_, index) => String(index)}
            style={{
              height: Math.min(items().length * 32, Math.max(32, windowSize().height / 4)),
            }}
          >
            {(item) => (
              <View
                style={{
                  minHeight: 32,
                  paddingHorizontal: props.tuck === undefined ? 12 : 16,
                  paddingVertical: 8,
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 8,
                }}
              >
                <If
                  when={item().status === 'in_progress'}
                  else={<ChoiceIndicator kind="checkbox" checked={item().status === 'completed'} />}
                >
                  <Icon name="activity" color={C.accent} />
                </If>
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
          <If when={error()}>
            <Text style={[{ paddingHorizontal: 16, color: C.danger }, { numberOfLines: 1 }]}>
              {error()}
            </Text>
          </If>
        </If>
      </View>
    </If>
  );
}

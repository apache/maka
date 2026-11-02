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
import { batch, cleanup, signal, Text, View, List } from 'nsh';
import type { ComposerChecklistSource } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { Subscription } from './history';
import type { AgentChecklist, AgentTodoItem } from '../../../../packages/plugin-sdk/src/index.js';
import { C, bodyTextStyle } from './ui';
import { Icon } from './Icon';
import { ChoiceIndicator } from './ChoiceIndicator';

const itemHeight = bodyTextStyle.lineHeight + 16;

export function createChecklist(source: ComposerChecklistSource, height: () => number) {
  const snapshot = signal<AgentChecklist | null>(null);
  const items = signal<AgentTodoItem[]>([]);
  const nextOffset = signal<AgentChecklist['nextOffset']>(null);
  const loading = signal(false);
  const error = createText();
  let alive = true;
  let generation = 0;
  let stream: Subscription | null = null;
  const loadMore = async () => {
    const page = snapshot();
    const offset = nextOffset();
    if (!alive || loading() || !page || offset === null || offset === undefined) return;
    const currentGeneration = generation;
    loading.set(true);
    error.set('');
    try {
      const next = await source.read(offset);
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
    const opened = await source.watch(0);
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
  return {
    shown: () => !!error() || (!!snapshot()?.enabled && snapshot()!.total > 0),
    summary: () => (snapshot()?.total ? `${snapshot()!.completed}/${snapshot()!.total}` : ''),
    preview: () =>
      error() ||
      snapshot()?.current?.content ||
      (snapshot()?.completed === snapshot()?.total
        ? tr('All items complete')
        : tr('No active item')),
    problem: () => !!error(),
    content: () => (
      <View style={{ minHeight: 0, flexShrink: 1 }}>
        <List
          each={items()}
          onLoadMore={() => void loadMore()}
          footer={() => (
            <If when={error()}>
              <Text style={[{ paddingHorizontal: 16, color: C.danger }]}>{error()}</Text>
            </If>
          )}
          estimatedItemSize={itemHeight}
          keyExtractor={(_, index) => String(index)}
          style={{
            minHeight: 0,
            flexShrink: 1,
            height: error() ? height() : Math.min(items().length * itemHeight, height()),
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
                  else={<ChoiceIndicator kind="checkbox" checked={item().status === 'completed'} />}
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
      </View>
    ),
  };
}

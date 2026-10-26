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
import { errorText, renderText, type UiText } from './text';
import { tr } from './locale';
import { cleanup, effect, inputAction, signal, Text, untracked, View, List } from 'nsh';
import { Button } from 'nsh/base';
import { host } from './host';
import type { GitStatus, GitStatusEntry } from '../../../../packages/plugin-sdk/src/index.js';
import { gitAreaLabel, type CurrentDiffTarget } from './CurrentDiff';
import { Icon } from './Icon';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
} from './ui';

const changeKindLabel: Record<GitStatusEntry['kind'], string> = {
  get added() {
    return tr('added');
  },
  get modified() {
    return tr('modified');
  },
  get deleted() {
    return tr('deleted');
  },
  get type_changed() {
    return tr('type changed');
  },
  get conflicted() {
    return tr('conflicted');
  },
};

type ChangesState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: GitStatus | null }
  | { kind: 'error'; message: UiText };

export function WorkspaceChanges(props: {
  sessionId: string;
  openDiff(target: CurrentDiffTarget): void;
}) {
  const state = signal<ChangesState>({ kind: 'loading' });
  let generation = 0;
  let alive = true;
  cleanup(() => {
    alive = false;
    generation += 1;
  });
  const refresh = async (sessionId: string) => {
    if (!alive || sessionId !== props.sessionId) return;
    const reading = ++generation;
    state.set({ kind: 'loading' });
    try {
      const status: GitStatus | null = await host.query('agent', 'gitStatus', { sessionId });
      if (alive && generation === reading && props.sessionId === sessionId)
        state.set({ kind: 'ready', status });
    } catch (reason) {
      if (alive && generation === reading && props.sessionId === sessionId)
        state.set({ kind: 'error', message: errorText(reason) });
    }
  };
  effect(() => {
    const sessionId = props.sessionId;
    untracked(() => void refresh(sessionId));
  });
  const status = () => {
    const current = state();
    return current.kind === 'ready' ? current.status : null;
  };
  const entries = () => status()?.entries ?? [];
  const open = (target: CurrentDiffTarget) => {
    if (
      alive &&
      target.sessionId === props.sessionId &&
      entries().some(
        (entry) => entry.area === target.area && entry.path.bytesBase64 === target.path.bytesBase64,
      )
    )
      props.openDiff(target);
  };
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ ...captionTextStyle, flex: 1, color: C.secondary, fontWeight: '500' }}>
          {tr('Current changes')}
        </Text>
        <Button
          accessibilityLabel={tr('Refresh current changes')}
          onPress={inputAction(refresh, props.sessionId)}
          tooltip={textTooltip(() =>
            state().kind === 'error' ? tr('Retry current changes') : tr('Refresh current changes'),
          )}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
        >
          <Icon name="refresh" color={C.secondary} />
        </Button>
      </View>
      <If when={state().kind === 'loading'}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Reading current changes…')}</Text>
      </If>
      <If when={state().kind === 'error'}>
        <Text selectable style={{ ...bodyTextStyle, color: C.danger }}>
          {renderText((state() as Extract<ChangesState, { kind: 'error' }>).message)}
        </Text>
      </If>
      <If when={state().kind === 'ready'}>
        <If
          when={status() !== null}
          else={
            <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Not a Git workspace.')}</Text>
          }
        >
          <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.muted }}>
            {tr('{head} · {count} changes', {
              head: status()?.head ?? tr('No commits yet'),
              count: entries().length,
            })}
          </Text>
          <List
            accessibilityLabel={tr('Current workspace changes')}
            each={entries()}
            keyExtractor={(entry: GitStatusEntry) => `${entry.area}/${entry.path.bytesBase64}`}
            estimatedItemSize={48}
            style={{ flex: 1, minHeight: 0 }}
            empty={
              <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('No current changes.')}</Text>
            }
          >
            {(entry) => (
              <Button
                accessibilityLabel={tr('Open {area} diff: {path}', {
                  area: gitAreaLabel[entry().area],
                  path: host.pathLabel(entry().path),
                })}
                onPress={inputAction(open, {
                  sessionId: props.sessionId,
                  area: entry().area,
                  path: entry().path,
                  title: host.pathLabel(entry().path),
                })}
                style={{
                  ...controlStyle,
                  paddingHorizontal: 8,
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
              >
                <Icon name="file" color={entry().kind === 'deleted' ? C.danger : C.muted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.text }}>
                    {host.pathLabel(entry().path)}
                  </Text>
                  <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.muted }}>
                    {gitAreaLabel[entry().area]} · {changeKindLabel[entry().kind]}
                  </Text>
                </View>
              </Button>
            )}
          </List>
        </If>
      </If>
    </View>
  );
}

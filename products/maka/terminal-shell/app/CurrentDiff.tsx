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

import { errorText, renderText, type UiText } from './text';
import { tr } from './locale';
import { cleanup, computed, inputAction, signal, Text, View, List } from 'nsh';
import { Button, SelectionArea } from 'nsh/base';
import { host } from './host';
import type { GitArea, GitDiff, WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import { parsePatch } from '../../desktop-shell/app/patch.js';
import { Icon } from './Icon';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  codeTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
} from './ui';

export const gitAreaLabel: Record<GitArea, string> = {
  get staged() {
    return tr('Staged');
  },
  get worktree() {
    return tr('Worktree');
  },
  get untracked() {
    return tr('Untracked');
  },
};

export type CurrentDiffTarget = {
  sessionId: string;
  area: GitArea;
  path: WorkspacePath;
  title: string;
};
type PatchRow = ReturnType<typeof parsePatch>[number];
type DiffRow = {
  key: string;
  kind: PatchRow['kind'];
  text: string;
  old: number | null;
  new: number | null;
};

// One native row per source line; Text wraps at the actual reader width.
function diffRows(patch: string): DiffRow[] {
  return parsePatch(patch).map((row, index) => ({
    key: String(index),
    kind: row.kind,
    text: row.text,
    old: 'old' in row ? row.old : null,
    new: 'new' in row ? row.new : null,
  }));
}

type DiffState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: UiText }
  | { kind: 'text'; rows: DiffRow[] }
  | Exclude<GitDiff, { kind: 'text' }>;
export type CurrentDiffModel = {
  target: CurrentDiffTarget;
  state(): DiffState;
  position: { x: number; y: number };
  refresh(): Promise<void>;
  dispose(): void;
};

// The resource tab owns this projection across dock/Dialog presentation changes.
// The existing gitDiff query returns a whole patch without a size bound.
export function createCurrentDiff(target: CurrentDiffTarget): CurrentDiffModel {
  const state = signal<DiffState>({ kind: 'loading' });
  let generation = 0;
  let alive = true;
  let previous: GitDiff | null | undefined;
  const refresh = async () => {
    if (!alive) return;
    const reading = ++generation;
    state.set({ kind: 'loading' });
    try {
      const result: GitDiff | null = await host.query('agent', 'gitDiff', {
        sessionId: target.sessionId,
        area: target.area,
        path: target.path,
      });
      if (!alive || reading !== generation) return;
      const same =
        previous !== undefined &&
        (result === null
          ? previous === null
          : previous !== null &&
            previous.kind === result.kind &&
            (result.kind !== 'text' ||
              (previous.kind === 'text' && previous.patch === result.patch)));
      if (!same) model.position = { x: 0, y: 0 };
      previous = result;
      state.set(
        result === null
          ? { kind: 'unavailable' }
          : result.kind === 'text'
            ? { kind: 'text', rows: diffRows(result.patch) }
            : result,
      );
    } catch (reason) {
      if (alive && reading === generation) state.set({ kind: 'error', message: errorText(reason) });
    }
  };
  const model: CurrentDiffModel = {
    target,
    state,
    position: { x: 0, y: 0 },
    refresh,
    dispose() {
      alive = false;
      generation += 1;
    },
  };
  void refresh();
  return model;
}

export function CurrentDiff(props: { model: CurrentDiffModel }) {
  const model = props.model;
  const notice = () => {
    const state = model.state();
    switch (state.kind) {
      case 'loading':
        return tr('Reading current diff…');
      case 'unavailable':
        return tr('Not a Git workspace.');
      case 'binary':
        return tr('Binary file. A text diff is unavailable.');
      case 'unchanged':
        return tr('No current changes in this area.');
      case 'unsupported':
        return tr('This change does not support a text diff.');
      case 'error':
        return renderText(state.message);
      case 'text':
        return '';
    }
  };
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="code" color={C.muted} />
        <Text
          numberOfLines={1}
          style={{ ...captionTextStyle, flex: 1, color: C.text, fontWeight: '500' }}
        >
          {model.target.title}
        </Text>
        <Button
          accessibilityLabel={tr('Refresh current diff')}
          onPress={inputAction(model.refresh, null)}
          tooltip={
            model.state().kind === 'error' ? tr('Retry current diff') : tr('Refresh current diff')
          }
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
        >
          <Icon name="refresh" color={C.secondary} />
        </Button>
      </View>
      <Text style={{ ...captionTextStyle, color: C.muted }}>
        {tr('Current {area} diff', { area: gitAreaLabel[model.target.area].toLowerCase() })}
      </Text>
      <If when={notice()}>
        <Text
          selectable
          style={{ ...bodyTextStyle, color: model.state().kind === 'error' ? C.danger : C.muted }}
        >
          {notice()}
        </Text>
      </If>
      <If when={model.state().kind === 'text'}>
        <DiffRows model={model} />
      </If>
    </View>
  );
}

function DiffRows(props: { model: CurrentDiffModel }) {
  const model = props.model;
  const initialOffset = { ...model.position };
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  const rows = () => {
    const state = model.state();
    return state.kind === 'text' ? state.rows : [];
  };
  const digits = computed(() => {
    let width = 1;
    for (const row of rows()) {
      if (row.old !== null) width = Math.max(width, String(row.old).length);
      if (row.new !== null) width = Math.max(width, String(row.new).length);
    }
    return width;
  });
  return (
    <SelectionArea style={{ flex: 1, minHeight: 0 }}>
      <List
        accessibilityLabel={tr('Current file diff')}
        each={rows()}
        keyExtractor={(row: DiffRow) => row.key}
        estimatedItemSize={codeTextStyle.lineHeight}
        contentOffset={initialOffset}
        onScroll={(event) => {
          if (mounted) model.position = { x: event.offset.x, y: event.offset.y };
        }}
        style={{ flex: 1, minHeight: 0, backgroundColor: C.surface }}
        empty={
          <Text selectable={false} style={{ ...bodyTextStyle, color: C.muted }}>
            {tr('The current patch has no displayable rows.')}
          </Text>
        }
      >
        {(row) => (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              minWidth: 0,
              backgroundColor:
                row().kind === 'added'
                  ? '#203527'
                  : row().kind === 'removed'
                    ? '#382528'
                    : undefined,
            }}
          >
            <If when={row().kind !== 'hunk' && row().kind !== 'meta'}>
              <Text
                selectable={false}
                style={{
                  ...codeTextStyle,
                  width: (digits() + 1) * 8,
                  flexShrink: 0,
                  paddingRight: 8,
                  textAlign: 'right',
                  color: C.muted,
                }}
              >
                {row().old ?? ''}
              </Text>
              <Text
                selectable={false}
                style={{
                  ...codeTextStyle,
                  width: (digits() + 1) * 8,
                  flexShrink: 0,
                  paddingRight: 8,
                  textAlign: 'right',
                  color: C.muted,
                }}
              >
                {row().new ?? ''}
              </Text>
              <Text
                selectable={false}
                style={{
                  ...codeTextStyle,
                  width: 8,
                  flexShrink: 0,
                  color:
                    row().kind === 'added'
                      ? '#9bd5a5'
                      : row().kind === 'removed'
                        ? C.danger
                        : C.text,
                }}
              >
                {row().kind === 'added' ? '+' : row().kind === 'removed' ? '-' : ' '}
              </Text>
            </If>
            <Text
              selectable
              style={{
                ...codeTextStyle,
                flex: 1,
                minWidth: 0,
                color:
                  row().kind === 'added'
                    ? '#9bd5a5'
                    : row().kind === 'removed'
                      ? C.danger
                      : row().kind === 'context'
                        ? C.text
                        : C.muted,
              }}
            >
              {row().text}
            </Text>
          </View>
        )}
      </List>
    </SelectionArea>
  );
}

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

import { cleanup, computed, effect, inputAction, List, signal, Text, untracked, View } from 'nsh';
import {
  Button,
  DiffView,
  type DiffAnnotation,
  type DiffFile,
  type DiffLineRange,
  type DiffSide,
  type DiffStats,
  type DiffViewRef,
} from 'nsh/base';
import type {
  GitArea,
  GitStatus,
  GitStatusEntry,
} from '../../../../packages/plugin-sdk/src/index.js';
import {
  type CurrentDiffTarget,
  gitAreaLabel,
} from '../../../../products/maka/workbench/app/CurrentDiff';
import { useHost } from '../../../../products/maka/workbench/app/host';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { tr } from '../../../../products/maka/workbench/app/locale';
import {
  AddLineNoteButton,
  formatReviewNote,
  InlineReviewComposer,
} from '../../../../products/maka/workbench/app/ReviewComposer';
import type {
  GitWorkspaceDiff,
  ReviewStore,
} from '../../../../products/maka/workbench/app/reviewState';
import { errorText, renderText, type UiText } from '../../../../products/maka/workbench/app/text';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from '../../../../products/maka/workbench/app/ui';

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

const changeKindColor = (kind: GitStatusEntry['kind']) =>
  kind === 'added'
    ? C.success
    : kind === 'deleted' || kind === 'conflicted'
      ? C.danger
      : C.secondary;

const formatHeadLabel = (head: string): string =>
  /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 7) : head;

type ChangesState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: GitStatus | null }
  | { kind: 'error'; message: UiText };

type AllDiffState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; diff: GitWorkspaceDiff | null }
  | { kind: 'error'; message: UiText };

export function WorkspaceChanges(props: {
  sessionId: string;
  openDiff(target: CurrentDiffTarget): void;
  openFile?(pathLabel: string): void;
  reviewStore?: ReviewStore;
  canPrompt?: boolean;
  deliverPrompt?(text: string, mode: 'insert' | 'send'): boolean;
}) {
  const host = useHost();
  const state = signal<ChangesState>({ kind: 'loading' });
  const allDiffState = signal<AllDiffState>({ kind: 'idle' });
  const areaFilter = signal<'all' | GitArea>('all');
  const mode = signal<'list' | 'review-all'>('list');
  const layout = signal<'split' | 'unified'>('unified');
  const softWrap = signal(false);
  const stats = signal<DiffStats>({ added: 0, deleted: 0, hunks: 0 });
  const draftRange = signal<{
    side: DiffSide;
    start: number;
    end: number;
    excerpt: string;
    guessPath: string;
  } | null>(null);
  let diffRef: DiffViewRef | undefined;
  let generation = 0;
  let diffGeneration = 0;
  let alive = true;
  cleanup(() => {
    alive = false;
    generation += 1;
    diffGeneration += 1;
  });

  const loadWorkspaceDiff = async (sessionId: string, area: 'all' | GitArea) => {
    if (!alive || sessionId !== props.sessionId) return;
    const req = ++diffGeneration;
    allDiffState.set({ kind: 'loading' });
    try {
      const diff: GitWorkspaceDiff | null = await host.query('agent', 'gitWorkspaceDiff', {
        sessionId,
        ...(area === 'all' ? {} : { area }),
      });
      if (alive && req === diffGeneration && props.sessionId === sessionId) {
        allDiffState.set({ kind: 'ready', diff });
      }
    } catch (reason) {
      if (alive && req === diffGeneration && props.sessionId === sessionId) {
        allDiffState.set({
          kind: 'error',
          message: errorText(reason, 'Could not read file changes.'),
        });
      }
    }
  };

  const refresh = async (sessionId: string) => {
    if (!alive || sessionId !== props.sessionId) return;
    const reading = ++generation;
    state.set({ kind: 'loading' });
    try {
      const status: GitStatus | null = await host.query('agent', 'gitStatus', { sessionId });
      if (alive && generation === reading && props.sessionId === sessionId) {
        state.set({ kind: 'ready', status });
        if (mode() === 'review-all') {
          void loadWorkspaceDiff(sessionId, areaFilter());
        }
      }
    } catch (reason) {
      if (alive && generation === reading && props.sessionId === sessionId)
        state.set({ kind: 'error', message: errorText(reason, 'Could not read file changes.') });
    }
  };

  effect(() => {
    const sessionId = props.sessionId;
    untracked(() => void refresh(sessionId));
  });

  effect(() => {
    const curMode = mode();
    const area = areaFilter();
    const sessionId = props.sessionId;
    if (curMode === 'review-all') {
      untracked(() => void loadWorkspaceDiff(sessionId, area));
    }
  });

  const status = () => {
    const current = state();
    return current.kind === 'ready' ? current.status : null;
  };
  const allEntries = () => status()?.entries ?? [];
  const filteredEntries = computed(() => {
    const filter = areaFilter();
    return filter === 'all' ? allEntries() : allEntries().filter((entry) => entry.area === filter);
  });
  const failure = () => {
    const current = state();
    return current.kind === 'error' ? renderText(current.message) : '';
  };

  const open = (target: CurrentDiffTarget) => {
    if (
      alive &&
      target.sessionId === props.sessionId &&
      allEntries().some(
        (entry) => entry.area === target.area && entry.path.bytesBase64 === target.path.bytesBase64,
      )
    )
      props.openDiff(target);
  };

  const openDiffByPathLabel = (pathLabel: string) => {
    const match =
      filteredEntries().find((e) => host.pathLabel(e.path) === pathLabel) ??
      allEntries().find((e) => host.pathLabel(e.path) === pathLabel);
    if (match) {
      props.openDiff({
        sessionId: props.sessionId,
        area: match.area,
        path: match.path,
        title: pathLabel,
      });
    }
  };

  const draftAnnotations = computed<DiffAnnotation[]>(() => {
    const cur = draftRange();
    if (!cur) return [];
    return [{ id: '__all_draft__', side: cur.side, line: cur.end }];
  });

  const startAllDraft = async (range: DiffLineRange) => {
    diffRef?.setSelectedLines(range);
    const [excerpt, files] = await Promise.all([
      diffRef ? diffRef.selectedText() : Promise.resolve(''),
      diffRef ? diffRef.files() : Promise.resolve([]),
    ]);
    draftRange.set({
      side: range.side,
      start: range.start,
      end: range.end,
      excerpt,
      guessPath: files[0]?.path ?? 'workspace',
    });
  };

  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Text
          style={{
            ...captionTextStyle,
            flex: 1,
            minWidth: 80,
            color: C.secondary,
            fontWeight: '500',
          }}
        >
          {status() !== null
            ? tr('{head} · {count} changes', {
                head: status()?.head ? formatHeadLabel(status()!.head!) : tr('No commits yet'),
                count: allEntries().length,
              })
            : tr('Current changes')}
        </Text>

        <If when={status() !== null && allEntries().length > 0}>
          <View
            role="tablist"
            style={{
              flexDirection: 'row',
              backgroundColor: C.card,
              padding: 2,
              borderRadius: 6,
              gap: 2,
            }}
          >
            <Button
              role="tab"
              selected={mode() === 'list'}
              onPress={() => mode.set('list')}
              style={{
                height: 24,
                paddingHorizontal: 8,
                borderRadius: 4,
                justifyContent: 'center',
                backgroundColor: mode() === 'list' ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: mode() === 'list' ? C.text : C.secondary,
                }}
              >
                {tr('File list')}
              </Text>
            </Button>
            <Button
              role="tab"
              selected={mode() === 'review-all'}
              onPress={() => mode.set('review-all')}
              style={{
                height: 24,
                paddingHorizontal: 8,
                borderRadius: 4,
                justifyContent: 'center',
                backgroundColor: mode() === 'review-all' ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: mode() === 'review-all' ? C.text : C.secondary,
                }}
              >
                {tr('Review all')}
              </Text>
            </Button>
          </View>
        </If>

        <Button
          accessibilityLabel={tr('Refresh current changes')}
          onPress={inputAction(refresh, props.sessionId)}
          tooltip={textTooltip(() =>
            state().kind === 'error' ? tr('Retry current changes') : tr('Refresh current changes'),
          )}
          style={{
            ...controlStyle,
            width: 28,
            minHeight: 28,
            paddingHorizontal: 6,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="refresh" size={14} color={C.secondary} />
        </Button>
      </View>

      <If when={status() !== null && allEntries().length > 0}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <Each of={['all', 'worktree', 'staged', 'untracked'] as const} key={(item) => item}>
            {(item) => {
              const label = () => (item() === 'all' ? tr('All') : gitAreaLabel[item() as GitArea]);
              const selected = () => areaFilter() === item();
              return (
                <Button
                  selected={selected()}
                  onPress={() => areaFilter.set(item())}
                  style={{
                    minHeight: 24,
                    height: 24,
                    paddingHorizontal: 8,
                    borderRadius: 6,
                    justifyContent: 'center',
                    backgroundColor: selected() ? C.cardRaised : C.card,
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                >
                  <Text
                    style={{
                      ...captionTextStyle,
                      color: selected() ? C.text : C.muted,
                      fontWeight: selected() ? '500' : undefined,
                    }}
                  >
                    {label()}
                  </Text>
                </Button>
              );
            }}
          </Each>

          <If when={mode() === 'review-all'}>
            <View style={{ flex: 1 }} />
            <Button
              selected={layout() === 'split'}
              onPress={() => layout.set(layout() === 'split' ? 'unified' : 'split')}
              style={{
                minHeight: 24,
                height: 24,
                paddingHorizontal: 8,
                borderRadius: 6,
                justifyContent: 'center',
                backgroundColor: C.card,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {layout() === 'split' ? tr('Split') : tr('Unified')}
              </Text>
            </Button>
            <Button
              accessibilityLabel={tr('Previous change')}
              disabled={stats().hunks === 0}
              onPress={() => diffRef?.previousHunk()}
              style={{
                ...controlStyle,
                width: 24,
                minHeight: 24,
                paddingHorizontal: 4,
                alignItems: 'center',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="up" size={13} color={C.secondary} />
            </Button>
            <Button
              accessibilityLabel={tr('Next change')}
              disabled={stats().hunks === 0}
              onPress={() => diffRef?.nextHunk()}
              style={{
                ...controlStyle,
                width: 24,
                minHeight: 24,
                paddingHorizontal: 4,
                alignItems: 'center',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="down" size={13} color={C.secondary} />
            </Button>
            <Button
              accessibilityLabel={tr('Wrap lines')}
              selected={softWrap()}
              onPress={() => softWrap.set(!softWrap())}
              style={{
                ...controlStyle,
                width: 24,
                minHeight: 24,
                paddingHorizontal: 4,
                alignItems: 'center',
                backgroundColor: softWrap() ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name={softWrap() ? 'wrap' : 'nowrap'} size={13} color={C.secondary} />
            </Button>
          </If>
        </View>
      </If>

      <If when={state().kind === 'loading'}>
        <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Reading current changes…')}</Text>
      </If>

      <If when={failure()}>
        <View
          style={{ flex: 1, minHeight: 0, justifyContent: 'center', alignItems: 'center', gap: 8 }}
        >
          <Text
            style={[
              { ...bodyTextStyle, color: C.secondary, textAlign: 'center' },
              { userSelect: 'text' },
            ]}
          >
            {failure()}
          </Text>
          <Button
            onPress={inputAction(refresh, props.sessionId)}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.accent }}>
              {tr('Retry current changes')}
            </Text>
          </Button>
        </View>
      </If>

      <If when={state().kind === 'ready'}>
        <If
          when={status() !== null}
          else={
            <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Not a Git workspace.')}</Text>
          }
        >
          <If when={mode() === 'list'}>
            <List
              accessibilityLabel={tr('Current workspace changes')}
              each={filteredEntries()}
              keyExtractor={(entry: GitStatusEntry) => `${entry.area}/${entry.path.bytesBase64}`}
              estimatedItemSize={44}
              style={{ flex: 1, minHeight: 0 }}
              empty={
                <Text style={{ ...bodyTextStyle, color: C.muted }}>
                  {allEntries().length === 0
                    ? tr('No current changes.')
                    : tr('No matching changes.')}
                </Text>
              }
            >
              {(entry) => (
                <Button
                  accessibilityLabel={tr('Open {area} diff: {path}', {
                    area: gitAreaLabel[entry().area],
                    path: String(host.pathLabel(entry().path)),
                  })}
                  onPress={inputAction(open, {
                    sessionId: props.sessionId,
                    area: entry().area,
                    path: entry().path,
                    title: host.pathLabel(entry().path),
                  })}
                  style={{
                    ...controlStyle,
                    paddingVertical: 6,
                    paddingHorizontal: 8,
                    marginBottom: 4,
                    borderRadius: 8,
                    backgroundColor: C.card,
                    gap: 2,
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Icon name="code" size={13} color={C.muted} />
                    <Text
                      style={[
                        { ...bodyTextStyle, flex: 1, minWidth: 0, color: C.text },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {host.pathLabel(entry().path)}
                    </Text>
                  </View>
                  <View
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 19 }}
                  >
                    <Text style={{ ...captionTextStyle, color: changeKindColor(entry().kind) }}>
                      {changeKindLabel[entry().kind]}
                    </Text>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {gitAreaLabel[entry().area]}
                    </Text>
                  </View>
                </Button>
              )}
            </List>
          </If>

          <If when={mode() === 'review-all'}>
            <If when={allDiffState().kind === 'loading' || allDiffState().kind === 'idle'}>
              <Text style={{ ...bodyTextStyle, color: C.muted }}>
                {tr('Reading current diff…')}
              </Text>
            </If>
            <If when={allDiffState().kind === 'error'}>
              <Text style={{ ...bodyTextStyle, color: C.danger }}>
                {allDiffState().kind === 'error'
                  ? renderText((allDiffState() as Extract<AllDiffState, { kind: 'error' }>).message)
                  : ''}
              </Text>
            </If>
            <If
              when={
                allDiffState().kind === 'ready' &&
                (!(allDiffState() as Extract<AllDiffState, { kind: 'ready' }>).diff ||
                  (allDiffState() as Extract<AllDiffState, { kind: 'ready' }>).diff!.patch.trim()
                    .length === 0)
              }
            >
              <Text style={{ ...bodyTextStyle, color: C.muted }}>
                {allEntries().length === 0 ? tr('No current changes.') : tr('No matching changes.')}
              </Text>
            </If>
            <If
              when={
                allDiffState().kind === 'ready' &&
                Boolean(
                  (allDiffState() as Extract<AllDiffState, { kind: 'ready' }>).diff?.patch.trim()
                    .length,
                )
              }
            >
              <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
                <If
                  when={(() => {
                    const cur = allDiffState();
                    return (
                      cur.kind === 'ready' &&
                      Boolean(cur.diff && (cur.diff.truncated || cur.diff.skippedFiles > 0))
                    );
                  })()}
                >
                  <Text style={{ ...captionTextStyle, color: C.muted }}>
                    {(() => {
                      const cur = allDiffState();
                      const d = cur.kind === 'ready' ? cur.diff : null;
                      if (!d) return '';
                      return d.truncated
                        ? tr('Diff truncated; {count} binary or large files omitted.', {
                            count: d.skippedFiles,
                          })
                        : tr('{count} non-text files omitted.', { count: d.skippedFiles });
                    })()}
                  </Text>
                </If>
                <View
                  style={{
                    flex: 1,
                    minHeight: 0,
                    borderRadius: 8,
                    overflow: 'hidden',
                    backgroundColor: C.card,
                  }}
                >
                  <DiffView
                    ref={(node) => {
                      diffRef = node;
                    }}
                    patch={(() => {
                      const cur = allDiffState();
                      return cur.kind === 'ready' && cur.diff ? cur.diff.patch : '';
                    })()}
                    layout={layout()}
                    inline="wordAlt"
                    indicators="bars"
                    lineNumbers
                    softWrap={softWrap()}
                    fontSize={codeTextStyle.fontSize}
                    lineHeight={codeTextStyle.lineHeight}
                    onStatsChange={({ stats: next }) => stats.set(next)}
                    renderFileHeader={(file: DiffFile) => (
                      <View
                        style={{
                          flex: 1,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                          paddingHorizontal: 10,
                          backgroundColor: C.panel,
                          borderBottomWidth: 1,
                          borderBottomColor: C.line,
                        }}
                      >
                        <Button
                          onPress={() => diffRef?.toggleFile(file.path)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                          }}
                          hoverStyle={quietHoverStyle()}
                          focusStyle={quietFocusStyle()}
                        >
                          <Icon
                            name={file.collapsed ? 'right' : 'down'}
                            size={13}
                            color={C.muted}
                          />
                          <Text
                            style={[
                              { ...captionTextStyle, flex: 1, color: C.text, fontWeight: '500' },
                              { numberOfLines: 1 },
                            ]}
                          >
                            {file.path}
                          </Text>
                          <Text style={{ ...captionTextStyle, color: C.success }}>
                            +{file.added}
                          </Text>
                          <Text style={{ ...captionTextStyle, color: C.danger }}>
                            −{file.deleted}
                          </Text>
                        </Button>
                        <Button
                          accessibilityLabel={tr('Review')}
                          onPress={() => openDiffByPathLabel(file.path)}
                          style={{
                            minHeight: 22,
                            height: 22,
                            paddingHorizontal: 6,
                            borderRadius: 4,
                            justifyContent: 'center',
                            backgroundColor: C.card,
                          }}
                          hoverStyle={controlHoverStyle()}
                          focusStyle={controlFocusStyle()}
                        >
                          <Text style={{ ...captionTextStyle, fontSize: 11, color: C.secondary }}>
                            {tr('Review')}
                          </Text>
                        </Button>
                      </View>
                    )}
                    annotations={draftAnnotations()}
                    renderAddAnnotation={
                      props.reviewStore && props.deliverPrompt
                        ? (range) => <AddLineNoteButton onPress={() => void startAllDraft(range)} />
                        : undefined
                    }
                    renderAnnotation={
                      props.reviewStore && props.deliverPrompt
                        ? () => {
                            const cur = draftRange();
                            if (!cur) return <View />;
                            const guessPath = cur.guessPath;
                            const matchEntry =
                              allEntries().find((e) => host.pathLabel(e.path) === guessPath) ??
                              allEntries()[0];
                            return (
                              <InlineReviewComposer
                                startLine={cur.start}
                                endLine={cur.end}
                                canPrompt={props.canPrompt ?? false}
                                onSave={(comment) => {
                                  if (matchEntry) {
                                    props.reviewStore!.upsertNote({
                                      sessionId: props.sessionId,
                                      path: matchEntry.path,
                                      pathLabel: host.pathLabel(matchEntry.path),
                                      area: matchEntry.area,
                                      side: cur.side,
                                      startLine: cur.start,
                                      endLine: cur.end,
                                      excerpt: cur.excerpt,
                                      comment,
                                    });
                                  }
                                  draftRange.set(null);
                                }}
                                onInsertPrompt={(comment) => {
                                  const text = formatReviewNote({
                                    pathLabel: matchEntry
                                      ? host.pathLabel(matchEntry.path)
                                      : guessPath,
                                    side: cur.side,
                                    startLine: cur.start,
                                    endLine: cur.end,
                                    excerpt: cur.excerpt,
                                    comment,
                                  });
                                  if (props.deliverPrompt!(text, 'insert')) draftRange.set(null);
                                }}
                                onSendNow={(comment) => {
                                  const text = formatReviewNote({
                                    pathLabel: matchEntry
                                      ? host.pathLabel(matchEntry.path)
                                      : guessPath,
                                    side: cur.side,
                                    startLine: cur.start,
                                    endLine: cur.end,
                                    excerpt: cur.excerpt,
                                    comment,
                                  });
                                  if (props.deliverPrompt!(text, 'send')) draftRange.set(null);
                                }}
                                onCancel={() => draftRange.set(null)}
                              />
                            );
                          }
                        : undefined
                    }
                    style={{ flex: 1, minHeight: 0 }}
                  />
                </View>
              </View>
            </If>
          </If>
        </If>
      </If>
    </View>
  );
}

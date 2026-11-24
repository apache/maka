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

import { formatCount } from './numberFormat';
import { cleanup, computed, effect, inputAction, keymap, Scroll, signal, Text, View } from 'nsh';
import {
  Button,
  DiffView,
  type DiffAnnotation,
  type DiffLineRange,
  type DiffSide,
  type DiffStats,
  type DiffViewRef,
} from 'nsh/base';
import type { GitArea } from '../../../../packages/plugin-sdk/src/index.js';
import {
  createCurrentDiff,
  currentDiffTargetKey,
  type CurrentDiffModel,
  type CurrentDiffTarget,
  resolveDiffSource,
  resolveDiffSourceKey,
} from './currentDiffState';
import { InlineCallout, RegionEmptyError } from './Feedback';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  AddLineNoteButton,
  formatReviewNote,
  GitHubThreadCard,
  InlineReviewComposer,
  InlineReviewNoteCard,
  PendingPrCommentCard,
  realLineRangeText,
} from './ReviewComposer';
import {
  buildPatchLineMap,
  type CodeLocation,
  extractLineIdentifiers,
  formatGitHubThreadPrompt,
  formatPrKey,
  type GitHubRepoRef,
  type GitHubReviewThread,
  isRangeInSinglePatchHunk,
  type PatchLineMap,
  type PendingPrComment,
  type ReviewNote,
  type ReviewStore,
} from './reviewState';
import { renderText } from './text';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';

export { createCurrentDiff, type CurrentDiffModel, type CurrentDiffTarget };

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

export type DiffReviewBridge = {
  store: ReviewStore;
  canPrompt: boolean;
  deliverPrompt(text: string, mode: 'insert' | 'send'): boolean;
  openDiff?(target: CurrentDiffTarget): void;
  openFileAt?(line: number): void;
  lookupSymbol?(kind: 'definition' | 'references', symbol: string, line: number): Promise<void>;
  openLocation?(loc: CodeLocation): void;
  replyPrThread?(
    repo: GitHubRepoRef,
    prNumber: number,
    threadId: number,
    body: string,
  ): Promise<string | null>;
};

type DraftAnnotation = {
  editNoteId?: string;
  editPrDraftId?: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  initialComment?: string;
};

export function CurrentDiff(props: { model: CurrentDiffModel; review?: DiffReviewBridge }) {
  const model = props.model;
  const layout = signal<'split' | 'unified'>('unified');
  const softWrap = signal(false);
  const expandedAll = signal(false);
  const showOutdated = signal(false);
  const stats = signal<DiffStats>({ added: 0, deleted: 0, hunks: 0 });
  const selectedRange = signal<DiffLineRange | null>(null);
  const activeSymbol = signal<string | null>(null);
  const draftNote = signal<DraftAnnotation | null>(null);
  let diffRef: DiffViewRef | undefined;
  let unbinds: (() => void)[] = [];
  cleanup(() => {
    for (const fn of unbinds) fn();
  });

  const source = () => resolveDiffSource(model.target);
  const sourceKey = () => resolveDiffSourceKey(model.target);
  const pathKey = () => model.target.path.bytesBase64;
  const prKey = () => {
    const src = source();
    return src.kind === 'pr' ? formatPrKey(src.repo, src.number) : null;
  };

  const sourceBadge = () => {
    const src = source();
    if (src.kind === 'working') return gitAreaLabel[src.area];
    if (src.kind === 'compare') return src.label;
    return `PR #${src.number}`;
  };

  const notice = () => {
    const state = model.state();
    switch (state.kind) {
      case 'loading':
        return tr('Reading current diff…');
      case 'unavailable':
        return tr('Not a Git workspace.');
      case 'binary':
        return tr('Binary file. A text diff is unavailable.');
      case 'large':
        return tr('Diff is too large to display inline.');
      case 'unchanged':
        return tr('No current changes in this area.');
      case 'unsupported':
        return tr('This change does not support a text diff.');
      case 'error':
        return renderText(state.message);
      case 'text':
      case 'patch_only':
        return '';
    }
  };

  const renderableState = computed(() => {
    const cur = model.state();
    if (cur.kind === 'text') {
      const usesPatch = cur.before === cur.after;
      return {
        mode: usesPatch ? ('patch' as const) : ('full' as const),
        before: cur.before,
        after: cur.after,
        patch: cur.patch,
        digest: cur.digest,
        patchMap: usesPatch ? buildPatchLineMap(cur.patch) : (null as PatchLineMap | null),
      };
    }
    if (cur.kind === 'patch_only') {
      return {
        mode: 'patch' as const,
        before: '',
        after: '',
        patch: cur.patch,
        digest: cur.digest,
        patchMap: buildPatchLineMap(cur.patch),
      };
    }
    return null;
  });

  const currentDigest = () => renderableState()?.digest ?? model.target.digest ?? '';

  const isViewed = computed(() => {
    const store = props.review?.store;
    const digest = currentDigest();
    if (!store || !digest) return false;
    return store.isViewed(model.target.sessionId, sourceKey(), pathKey(), digest);
  });

  const navContext = computed(() => {
    const store = props.review?.store;
    if (!store || !props.review?.openDiff) return null;
    const queue = store.reviewQueue(model.target.sessionId);
    if (queue.length <= 1) return null;
    const currentKey = currentDiffTargetKey(model.target);
    const index = queue.findIndex((item) => item.key === currentKey);
    if (index < 0) return null;
    return {
      index,
      total: queue.length,
      prev: index > 0 ? queue[index - 1]! : null,
      next: index + 1 < queue.length ? queue[index + 1]! : null,
    };
  });

  const toggleViewed = () => {
    const store = props.review?.store;
    const digest = currentDigest();
    if (!store || !digest) return;
    store.toggleViewed(model.target.sessionId, sourceKey(), pathKey(), digest);
  };

  const virtualToReal = (side: DiffSide, virtualLine: number): number => {
    const cur = renderableState();
    if (!cur?.patchMap) return virtualLine + 1;
    const arr = side === 'old' ? cur.patchMap.oldVirtualToReal : cur.patchMap.newVirtualToReal;
    return arr[virtualLine] ?? virtualLine + 1;
  };

  const realToVirtual = (side: DiffSide, realLine1: number): number | null => {
    const cur = renderableState();
    if (!cur) return null;
    if (!cur.patchMap) return Math.max(0, realLine1 - 1);
    const map = side === 'old' ? cur.patchMap.oldRealToVirtual : cur.patchMap.newRealToVirtual;
    const mapped = map.get(realLine1);
    return mapped === undefined ? null : mapped;
  };

  effect(() => {
    const anc = model.anchor();
    const cur = renderableState();
    if (!anc || !cur) return;
    setTimeout(() => {
      if (!diffRef) return;
      const range: DiffLineRange = {
        side: anc.side,
        start: anc.line,
        end: anc.endLine ?? anc.line,
      };
      selectedRange.set(range);
      diffRef.setSelectedLines(range);
      void (async () => {
        const hunks = await diffRef.hunks();
        const idx = hunks.findIndex((h) => {
          const start = anc.side === 'old' ? h.oldStart : h.newStart;
          const count = anc.side === 'old' ? h.oldLines : h.newLines;
          return anc.line >= start && anc.line <= start + Math.max(1, count);
        });
        if (idx >= 0) diffRef.goToHunk(idx);
      })();
    }, 0);
  });

  const extractExcerpt = (side: DiffSide, startLine: number, endLine: number): string => {
    const cur = renderableState();
    if (!cur) return '';
    const lo = Math.min(startLine, endLine);
    const hi = Math.max(startLine, endLine);
    if (cur.patchMap) {
      const lines = side === 'old' ? cur.patchMap.oldLines : cur.patchMap.newLines;
      return lines.slice(lo, hi + 1).join('\n');
    }
    const text = side === 'old' ? cur.before : cur.after;
    return text
      .split('\n')
      .slice(lo, hi + 1)
      .join('\n');
  };

  const selectedSymbols = computed(() => {
    const range = selectedRange();
    const cur = renderableState();
    if (!range || !cur || cur.mode !== 'full') return [];
    const snippet = extractExcerpt(range.side, range.start, Math.min(range.end, range.start + 3));
    return extractLineIdentifiers(snippet, 8);
  });

  const fileNotes = computed<ReviewNote[]>(() => {
    const store = props.review?.store;
    if (!store) return [];
    const curKey = currentDiffTargetKey(model.target);
    return store.notes(model.target.sessionId).filter((n) => {
      if (n.diffTarget) return currentDiffTargetKey(n.diffTarget) === curKey;
      return (
        n.path.bytesBase64 === model.target.path.bytesBase64 &&
        (n.area === undefined || n.area === model.target.area)
      );
    });
  });

  const filePrDrafts = computed<PendingPrComment[]>(() => {
    const store = props.review?.store;
    const key = prKey();
    const src = source();
    if (!store || !key || src.kind !== 'pr') return [];
    return store.prDrafts(model.target.sessionId, key).filter((d) => d.path === src.pathString);
  });

  const allFilePrThreads = computed<GitHubReviewThread[]>(() => {
    const store = props.review?.store;
    const key = prKey();
    const src = source();
    if (src.kind !== 'pr') return [];
    const fromStore = store && key ? store.prThreads(model.target.sessionId, key) : [];
    const sourceList = fromStore.length > 0 ? fromStore : model.threads();
    return sourceList.filter((t) => t.path === src.pathString);
  });

  const mappedPrThreads = computed(() => {
    const inline: {
      thread: GitHubReviewThread;
      side: DiffSide;
      virtualLine: number;
    }[] = [];
    const unmapped: GitHubReviewThread[] = [];
    for (const thread of allFilePrThreads()) {
      if (thread.outdated || thread.line === null) {
        unmapped.push(thread);
        continue;
      }
      const side: DiffSide = thread.side === 'LEFT' ? 'old' : 'new';
      const vLine = realToVirtual(side, thread.line);
      if (vLine === null) {
        unmapped.push(thread);
      } else {
        inline.push({ thread, side, virtualLine: vLine });
      }
    }
    return { inline, unmapped };
  });

  const annotations = computed<DiffAnnotation[]>(() => {
    const list: DiffAnnotation[] = [];
    for (const item of mappedPrThreads().inline) {
      list.push({
        id: `gh-thread:${item.thread.id}`,
        side: item.side,
        line: item.virtualLine,
      });
    }
    for (const draftItem of filePrDrafts()) {
      const side: DiffSide = draftItem.side === 'LEFT' ? 'old' : 'new';
      const vLine = realToVirtual(side, draftItem.line);
      if (vLine !== null) {
        list.push({
          id: `pr-draft:${draftItem.id}`,
          side,
          line: vLine,
        });
      }
    }
    for (const note of fileNotes()) {
      list.push({
        id: note.id,
        side: note.side,
        line: note.endLine,
      });
    }
    const draft = draftNote();
    if (draft && !draft.editNoteId && !draft.editPrDraftId) {
      list.push({
        id: '__draft__',
        side: draft.side,
        line: draft.endLine,
      });
    }
    return list;
  });

  const startDraft = (range: DiffLineRange) => {
    const lo = Math.min(range.start, range.end);
    const hi = Math.max(range.start, range.end);
    draftNote.set({
      side: range.side,
      startLine: lo,
      endLine: hi,
    });
  };

  const buildNoteInput = (draft: DraftAnnotation, comment: string) => ({
    ...(draft.editNoteId ? { id: draft.editNoteId } : {}),
    sessionId: model.target.sessionId,
    path: model.target.path,
    pathLabel: model.target.title,
    ...(model.target.area ? { area: model.target.area } : {}),
    diffTarget: model.target,
    side: draft.side,
    startLine: draft.startLine,
    endLine: draft.endLine,
    realStartLine: virtualToReal(draft.side, draft.startLine),
    realEndLine: virtualToReal(draft.side, draft.endLine),
    excerpt: extractExcerpt(draft.side, draft.startLine, draft.endLine),
    comment,
  });

  const prHunkMap = computed<PatchLineMap | null>(() => {
    if (source().kind !== 'pr') return null;
    const cur = renderableState();
    if (!cur) return null;
    return cur.patchMap ?? buildPatchLineMap(cur.patch);
  });

  const canPrCommentRange = (draft: DraftAnnotation): boolean => {
    const map = prHunkMap();
    if (!map) return false;
    const realStart = virtualToReal(draft.side, draft.startLine);
    const realEnd = virtualToReal(draft.side, draft.endLine);
    return isRangeInSinglePatchHunk(map, draft.side, realStart, realEnd);
  };

  const savePrDraftComment = (draft: DraftAnnotation, body: string) => {
    const src = source();
    const key = prKey();
    const store = props.review?.store;
    if (src.kind !== 'pr' || !key || !store || !canPrCommentRange(draft)) return;
    const side = draft.side === 'old' ? ('LEFT' as const) : ('RIGHT' as const);
    const realStart = virtualToReal(draft.side, draft.startLine);
    const realEnd = virtualToReal(draft.side, draft.endLine);
    store.upsertPrDraft(model.target.sessionId, {
      ...(draft.editPrDraftId ? { id: draft.editPrDraftId } : {}),
      prKey: key,
      path: src.pathString,
      side,
      line: Math.max(realStart, realEnd),
      ...(realStart < realEnd ? { startLine: Math.min(realStart, realEnd), startSide: side } : {}),
      excerpt: extractExcerpt(draft.side, draft.startLine, draft.endLine),
      body,
    });
    draftNote.set(null);
  };

  const toggleExpandAll = () => {
    const next = !expandedAll();
    expandedAll.set(next);
    if (next) diffRef?.expandAll();
    else diffRef?.collapseAll();
  };

  const openSourceAtSelection = async () => {
    if (!props.review?.openFileAt) return;
    const sel = selectedRange();
    const hunks = diffRef ? await diffRef.hunks() : [];
    const firstHunk = hunks[0];
    const vLine =
      sel?.side === 'new' ? sel.start : sel ? sel.start : firstHunk ? firstHunk.newStart : 0;
    const real1 = virtualToReal(sel?.side ?? 'new', vLine);
    props.review.openFileAt(Math.max(0, real1 - 1));
  };

  return (
    <View
      ref={(node) => {
        for (const fn of unbinds) fn();
        unbinds = node
          ? [
              keymap.bind('v', toggleViewed, {
                when: 'notEditing',
                within: node,
              }),
              keymap.bind(
                '[',
                () => {
                  const prev = navContext()?.prev;
                  if (prev) props.review?.openDiff?.(prev.target);
                },
                { when: 'notEditing', within: node },
              ),
              keymap.bind(
                ']',
                () => {
                  const next = navContext()?.next;
                  if (next) props.review?.openDiff?.(next.target);
                },
                { when: 'notEditing', within: node },
              ),
            ]
          : [];
      }}
      style={{ flex: 1, minHeight: 0, gap: 6 }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        <Icon name="code" size={14} color={C.muted} />
        <Text
          tooltip={textTooltip(() => model.target.title)}
          style={[
            {
              ...captionTextStyle,
              flex: 1,
              minWidth: 80,
              color: C.text,
              fontWeight: '500',
            },
            { numberOfLines: 1 },
          ]}
        >
          {model.target.title}
        </Text>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
            backgroundColor: C.card,
          }}
        >
          <Text
            style={{
              ...captionTextStyle,
              fontSize: 12,
              color: source().kind === 'pr' ? C.accent : C.secondary,
            }}
          >
            {sourceBadge()}
          </Text>
        </View>
        <If when={renderableState() !== null}>
          <Text style={{ ...captionTextStyle, color: C.success }}>
            +{formatCount(stats().added)}
          </Text>
          <Text style={{ ...captionTextStyle, color: C.danger }}>
            −{formatCount(stats().deleted)}
          </Text>
        </If>
        <If when={navContext() !== null}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
              backgroundColor: C.card,
              borderRadius: 6,
              padding: 2,
            }}
          >
            <Button
              accessibilityLabel={tr('Previous file')}
              tooltip={textTooltip(() => tr('Previous file · ['))}
              disabled={!navContext()?.prev}
              onPress={() => {
                const prev = navContext()?.prev;
                if (prev) props.review?.openDiff?.(prev.target);
              }}
              style={{
                ...controlStyle,
                width: 24,
                minHeight: 24,
                paddingHorizontal: 4,
                paddingVertical: 2,
                borderRadius: 4,
                alignItems: 'center',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="back" size={13} color={C.secondary} />
            </Button>
            <Text
              style={{
                ...captionTextStyle,
                fontSize: 12,
                paddingHorizontal: 4,
                color: C.muted,
              }}
            >
              {navContext()!.index + 1} / {navContext()!.total}
            </Text>
            <Button
              accessibilityLabel={tr('Next file')}
              tooltip={textTooltip(() => tr('Next file · ]'))}
              disabled={!navContext()?.next}
              onPress={() => {
                const next = navContext()?.next;
                if (next) props.review?.openDiff?.(next.target);
              }}
              style={{
                ...controlStyle,
                width: 24,
                minHeight: 24,
                paddingHorizontal: 4,
                paddingVertical: 2,
                borderRadius: 4,
                alignItems: 'center',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="right" size={13} color={C.secondary} />
            </Button>
          </View>
        </If>
        <If when={props.review !== undefined && currentDigest().length > 0}>
          <Button
            accessibilityLabel={tr('Mark file as viewed')}
            tooltip={textTooltip(() => tr('Mark file as viewed · V'))}
            selected={isViewed()}
            onPress={toggleViewed}
            style={{
              ...controlStyle,
              minHeight: 26,
              height: 26,
              paddingHorizontal: 8,
              borderRadius: 6,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: isViewed() ? C.added : C.card,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <Icon name="check" size={12} color={isViewed() ? C.success : C.muted} />
            <Text
              style={{
                ...captionTextStyle,
                fontSize: 12,
                color: isViewed() ? C.success : C.secondary,
                fontWeight: isViewed() ? '500' : '400',
              }}
            >
              {tr('Viewed')}
            </Text>
          </Button>
        </If>
      </View>

      <If when={renderableState() !== null}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            flexWrap: 'wrap',
          }}
        >
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
              selected={layout() === 'split'}
              onPress={() => layout.set('split')}
              style={{
                height: 24,
                paddingHorizontal: 8,
                borderRadius: 4,
                justifyContent: 'center',
                backgroundColor: layout() === 'split' ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: layout() === 'split' ? C.text : C.secondary,
                }}
              >
                {tr('Split')}
              </Text>
            </Button>
            <Button
              role="tab"
              selected={layout() === 'unified'}
              onPress={() => layout.set('unified')}
              style={{
                height: 24,
                paddingHorizontal: 8,
                borderRadius: 4,
                justifyContent: 'center',
                backgroundColor: layout() === 'unified' ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: layout() === 'unified' ? C.text : C.secondary,
                }}
              >
                {tr('Unified')}
              </Text>
            </Button>
          </View>

          <Button
            accessibilityLabel={tr('Previous change')}
            tooltip={textTooltip(() => tr('Previous change'))}
            disabled={stats().hunks === 0}
            onPress={() => diffRef?.previousHunk()}
            style={{
              ...controlStyle,
              width: 28,
              minHeight: 28,
              paddingHorizontal: 6,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="up" size={14} color={C.secondary} />
          </Button>
          <Button
            accessibilityLabel={tr('Next change')}
            tooltip={textTooltip(() => tr('Next change'))}
            disabled={stats().hunks === 0}
            onPress={() => diffRef?.nextHunk()}
            style={{
              ...controlStyle,
              width: 28,
              minHeight: 28,
              paddingHorizontal: 6,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="down" size={14} color={C.secondary} />
          </Button>

          <If when={renderableState()?.mode === 'full'}>
            <Button
              accessibilityLabel={
                expandedAll() ? tr('Collapse unchanged lines') : tr('Expand unchanged lines')
              }
              tooltip={textTooltip(() =>
                expandedAll() ? tr('Collapse unchanged lines') : tr('Expand unchanged lines'),
              )}
              selected={expandedAll()}
              onPress={toggleExpandAll}
              style={{
                ...controlStyle,
                width: 28,
                minHeight: 28,
                paddingHorizontal: 6,
                alignItems: 'center',
                backgroundColor: expandedAll() ? C.cardRaised : 'transparent',
              }}
              hoverStyle={quietHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="compaction" size={14} color={expandedAll() ? C.text : C.secondary} />
            </Button>
          </If>

          <Button
            accessibilityLabel={tr('Wrap lines')}
            tooltip={textTooltip(() => tr('Wrap lines'))}
            selected={softWrap()}
            onPress={() => softWrap.set(!softWrap())}
            style={{
              ...controlStyle,
              width: 28,
              minHeight: 28,
              paddingHorizontal: 6,
              alignItems: 'center',
              backgroundColor: softWrap() ? C.cardRaised : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon
              name={softWrap() ? 'wrap' : 'nowrap'}
              size={14}
              color={softWrap() ? C.text : C.secondary}
            />
          </Button>

          <View style={{ flex: 1 }} />

          <If when={props.review !== undefined}>
            <Button
              accessibilityLabel={tr('Add review note')}
              tooltip={textTooltip(() => tr('Add review note'))}
              onPress={() => {
                const sel = selectedRange();
                if (sel) {
                  startDraft(sel);
                  return;
                }
                void (async () => {
                  const hunks = diffRef ? await diffRef.hunks() : [];
                  const line = hunks[0] ? hunks[0].newStart : 0;
                  const range: DiffLineRange = {
                    side: 'new',
                    start: line,
                    end: line,
                  };
                  selectedRange.set(range);
                  startDraft(range);
                })();
              }}
              style={{
                ...controlStyle,
                width: 28,
                minHeight: 28,
                paddingHorizontal: 6,
                alignItems: 'center',
              }}
              hoverStyle={quietHoverStyle()}
              activeStyle={quietActiveStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="conversation" size={14} color={C.secondary} />
            </Button>
          </If>

          <If when={props.review?.openFileAt !== undefined}>
            <Button
              accessibilityLabel={tr('Open source file')}
              tooltip={textTooltip(() => tr('Open source file'))}
              onPress={() => void openSourceAtSelection()}
              style={{
                ...controlStyle,
                minHeight: 28,
                height: 28,
                paddingHorizontal: 8,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
              hoverStyle={quietHoverStyle()}
              activeStyle={quietActiveStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="file" size={13} color={C.secondary} />
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Source file')}</Text>
            </Button>
          </If>

          <Button
            accessibilityLabel={tr('Refresh current diff')}
            onPress={inputAction(model.refresh, null)}
            tooltip={textTooltip(() =>
              model.state().kind === 'error'
                ? tr('Retry current diff')
                : tr('Refresh current diff'),
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
      </If>

      <If when={mappedPrThreads().unmapped.length > 0 && props.review !== undefined}>
        <View
          style={{
            borderRadius: 8,
            backgroundColor: C.card,
            padding: 8,
            gap: 6,
          }}
        >
          <Button
            onPress={() => showOutdated.set(!showOutdated())}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingVertical: 2,
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name={showOutdated() ? 'down' : 'right'} size={13} color={C.muted} />
            <Text
              style={{
                ...captionTextStyle,
                color: C.secondary,
                fontWeight: '500',
              }}
            >
              {tr('{count} outdated review threads', {
                count: mappedPrThreads().unmapped.length,
              })}
            </Text>
          </Button>
          <If when={showOutdated()}>
            <Scroll style={{ maxHeight: 200 }}>
              <Each of={mappedPrThreads().unmapped} key={(t) => String(t.id)}>
                {(thread) => (
                  <GitHubThreadCard
                    thread={thread()}
                    canPrompt={props.review!.canPrompt}
                    onReply={async (body) => {
                      const src = source();
                      if (src.kind !== 'pr' || !props.review?.replyPrThread) {
                        return tr('GitHub replies are unavailable.');
                      }
                      return props.review.replyPrThread(src.repo, src.number, thread().id, body);
                    }}
                    onAskAgent={(mode) => {
                      const src = source();
                      const prNum = src.kind === 'pr' ? src.number : 0;
                      const promptText = formatGitHubThreadPrompt(prNum, thread());
                      props.review!.deliverPrompt(promptText, mode);
                    }}
                  />
                )}
              </Each>
            </Scroll>
          </If>
        </View>
      </If>

      <If when={Boolean(notice())}>
        <If
          when={renderableState() === null && model.state().kind === 'error'}
          else={
            <InlineCallout
              tone={model.state().kind === 'error' ? 'danger' : 'info'}
              message={notice()}
              action={
                model.state().kind === 'error'
                  ? { label: tr('Retry'), onPress: inputAction(model.refresh, null) }
                  : undefined
              }
            />
          }
        >
          <RegionEmptyError
            tone="danger"
            icon="diff"
            title={notice()}
            retry={inputAction(model.refresh, null)}
          />
        </If>
      </If>

      <If when={renderableState() !== null}>
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
            language={model.target.title}
            oldValue={(() => {
              const cur = renderableState();
              return cur && cur.mode === 'full' ? cur.before : undefined;
            })()}
            newValue={(() => {
              const cur = renderableState();
              return cur && cur.mode === 'full' ? cur.after : undefined;
            })()}
            patch={(() => {
              const cur = renderableState();
              return cur && cur.mode === 'patch' ? cur.patch : undefined;
            })()}
            layout={layout()}
            inline="wordAlt"
            indicators="bars"
            lineNumbers
            softWrap={softWrap()}
            expandAll={expandedAll()}
            fontSize={codeTextStyle.fontSize}
            lineHeight={codeTextStyle.lineHeight}
            onStatsChange={({ stats: next }) => stats.set(next)}
            onLineSelectionChange={({ range }) => {
              selectedRange.set(range);
              activeSymbol.set(null);
            }}
            onLineNumberPress={({ line }) => {
              selectedRange.set({
                side: line.side,
                start: line.line,
                end: line.line,
              });
            }}
            annotations={annotations()}
            renderAddAnnotation={
              props.review
                ? (range) => <AddLineNoteButton onPress={() => startDraft(range)} />
                : undefined
            }
            renderAnnotation={
              props.review
                ? (ann) => {
                    const draft = draftNote();
                    const isPr = source().kind === 'pr';
                    if (ann.id === '__draft__' && draft) {
                      const prAllowed = isPr && canPrCommentRange(draft);
                      return (
                        <InlineReviewComposer
                          startLine={draft.startLine}
                          endLine={draft.endLine}
                          realStartLine={virtualToReal(draft.side, draft.startLine)}
                          realEndLine={virtualToReal(draft.side, draft.endLine)}
                          canPrompt={props.review!.canPrompt}
                          prHunkNotice={
                            isPr && !prAllowed
                              ? tr(
                                  'Outside PR diff hunks — GitHub only accepts comments on changed hunk lines. Use local review actions below.',
                                )
                              : undefined
                          }
                          onAddPrComment={
                            prAllowed ? (comment) => savePrDraftComment(draft, comment) : undefined
                          }
                          onSave={(comment) => {
                            props.review!.store.upsertNote(buildNoteInput(draft, comment));
                            draftNote.set(null);
                          }}
                          onInsertPrompt={(comment) => {
                            const text = formatReviewNote(buildNoteInput(draft, comment));
                            if (props.review!.deliverPrompt(text, 'insert')) draftNote.set(null);
                          }}
                          onSendNow={(comment) => {
                            const text = formatReviewNote(buildNoteInput(draft, comment));
                            if (props.review!.deliverPrompt(text, 'send')) draftNote.set(null);
                          }}
                          onCancel={() => draftNote.set(null)}
                        />
                      );
                    }

                    if (ann.id.startsWith('gh-thread:')) {
                      const tid = Number(ann.id.slice('gh-thread:'.length));
                      const entry = mappedPrThreads().inline.find((i) => i.thread.id === tid);
                      if (!entry) return <View />;
                      return (
                        <GitHubThreadCard
                          thread={entry.thread}
                          canPrompt={props.review!.canPrompt}
                          onReply={async (body) => {
                            const src = source();
                            if (src.kind !== 'pr' || !props.review?.replyPrThread) {
                              return tr('GitHub replies are unavailable.');
                            }
                            return props.review.replyPrThread(
                              src.repo,
                              src.number,
                              entry.thread.id,
                              body,
                            );
                          }}
                          onAskAgent={(mode) => {
                            const src = source();
                            const prNum = src.kind === 'pr' ? src.number : 0;
                            const startV = entry.thread.startLine
                              ? (realToVirtual(entry.side, entry.thread.startLine) ??
                                entry.virtualLine)
                              : entry.virtualLine;
                            const excerpt = extractExcerpt(
                              entry.side,
                              Math.min(startV, entry.virtualLine),
                              entry.virtualLine,
                            );
                            const promptText = formatGitHubThreadPrompt(
                              prNum,
                              entry.thread,
                              excerpt,
                            );
                            props.review!.deliverPrompt(promptText, mode);
                          }}
                        />
                      );
                    }

                    if (ann.id.startsWith('pr-draft:')) {
                      const did = ann.id.slice('pr-draft:'.length);
                      const pending = filePrDrafts().find((d) => d.id === did);
                      if (!pending) return <View />;
                      if (draft?.editPrDraftId === pending.id) {
                        return (
                          <InlineReviewComposer
                            startLine={draft.startLine}
                            endLine={draft.endLine}
                            realStartLine={pending.startLine ?? pending.line}
                            realEndLine={pending.line}
                            initialComment={pending.body}
                            canPrompt={false}
                            prCommentMode
                            onAddPrComment={(comment) => savePrDraftComment(draft, comment)}
                            onSave={() => {}}
                            onInsertPrompt={() => {}}
                            onSendNow={() => {}}
                            onCancel={() => draftNote.set(null)}
                          />
                        );
                      }
                      const key = prKey();
                      return (
                        <PendingPrCommentCard
                          draft={pending}
                          onEdit={() => {
                            const side: DiffSide = pending.side === 'LEFT' ? 'old' : 'new';
                            const vEnd = realToVirtual(side, pending.line) ?? 0;
                            const vStart = pending.startLine
                              ? (realToVirtual(side, pending.startLine) ?? vEnd)
                              : vEnd;
                            draftNote.set({
                              editPrDraftId: pending.id,
                              side,
                              startLine: vStart,
                              endLine: vEnd,
                              initialComment: pending.body,
                            });
                          }}
                          onRemove={() => {
                            if (key) {
                              props.review!.store.removePrDraft(
                                model.target.sessionId,
                                key,
                                pending.id,
                              );
                            }
                          }}
                        />
                      );
                    }

                    const existing = fileNotes().find((n) => n.id === ann.id);
                    if (!existing) return <View />;
                    if (draft?.editNoteId === existing.id) {
                      return (
                        <InlineReviewComposer
                          startLine={existing.startLine}
                          endLine={existing.endLine}
                          realStartLine={existing.realStartLine}
                          realEndLine={existing.realEndLine}
                          initialComment={existing.comment}
                          canPrompt={props.review!.canPrompt}
                          onSave={(comment) => {
                            props.review!.store.upsertNote({
                              ...existing,
                              comment,
                            });
                            draftNote.set(null);
                          }}
                          onInsertPrompt={(comment) => {
                            const text = formatReviewNote({
                              ...existing,
                              comment,
                            });
                            if (props.review!.deliverPrompt(text, 'insert')) {
                              props.review!.store.removeNote(existing.sessionId, existing.id);
                              draftNote.set(null);
                            }
                          }}
                          onSendNow={(comment) => {
                            const text = formatReviewNote({
                              ...existing,
                              comment,
                            });
                            if (props.review!.deliverPrompt(text, 'send')) {
                              props.review!.store.removeNote(existing.sessionId, existing.id);
                              draftNote.set(null);
                            }
                          }}
                          onCancel={() => draftNote.set(null)}
                        />
                      );
                    }
                    return (
                      <InlineReviewNoteCard
                        note={existing}
                        canPrompt={props.review!.canPrompt}
                        onEdit={() =>
                          draftNote.set({
                            editNoteId: existing.id,
                            side: existing.side,
                            startLine: existing.startLine,
                            endLine: existing.endLine,
                            initialComment: existing.comment,
                          })
                        }
                        onRemove={() =>
                          props.review!.store.removeNote(existing.sessionId, existing.id)
                        }
                        onSendNow={() => {
                          const text = formatReviewNote(existing);
                          if (props.review!.deliverPrompt(text, 'send')) {
                            props.review!.store.removeNote(existing.sessionId, existing.id);
                          }
                        }}
                      />
                    );
                  }
                : undefined
            }
            style={{ flex: 1, minHeight: 0 }}
          />
        </View>
      </If>
    </View>
  );
}

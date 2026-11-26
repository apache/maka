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
  batch,
  cleanup,
  computed,
  keymap,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
  type ScrollRef,
} from 'nsh';
import { Button, Input, Popover } from 'nsh/base';
import { Icon } from './Icon';
import { tr } from './locale';
import { formatCount } from './numberFormat';
import type { GitWorktreeEntry } from './reviewState';
import {
  C,
  captionTextStyle,
  floatingStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
  quietFocusStyle,
  textTooltip,
} from './ui';

const ROW_HEIGHT = 44;
const ROW_GAP = 2;
const ROW_STEP = ROW_HEIGHT + ROW_GAP;

export function compactHomePath(path: string): string {
  const unixMatch = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(path);
  if (unixMatch) return '~' + (unixMatch[1] ?? '');
  const winMatch = /^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/.exec(path);
  if (winMatch) return '~' + (winMatch[1] ?? '');
  return path;
}

export function orderWorktrees(
  worktrees: readonly GitWorktreeEntry[],
): readonly GitWorktreeEntry[] {
  return [...worktrees].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function WorktreePicker(props: {
  worktrees(): readonly GitWorktreeEntry[];
  activeWorktree(): string | null;
  onSelect(worktreePath: string | null): void;
  variant: 'card' | 'pill';
  align?: 'start' | 'end';
  activeBranch?(): string | null | undefined;
}) {
  const open = signal(false);

  const ordered = computed(() => orderWorktrees(props.worktrees()));
  const selectedEntry = computed(() => {
    const list = ordered();
    const sel = props.activeWorktree();
    if (sel) return list.find((w) => w.path === sel) ?? list.find((w) => w.isCurrent) ?? null;
    return list.find((w) => w.isCurrent) ?? list[0] ?? null;
  });

  const isOverridden = () => {
    const cur = selectedEntry();
    return Boolean(props.activeWorktree() && cur && !cur.isCurrent);
  };

  const branchDisplay = () => {
    const liveBranch = props.activeBranch?.();
    if (liveBranch) return liveBranch;
    const cur = selectedEntry();
    if (!cur) return '';
    if (cur.branch) return cur.branch;
    return cur.isMain ? tr('Main checkout') : tr('Linked checkout');
  };

  const triggerTooltip = () => {
    const cur = selectedEntry();
    if (!cur) return tr('Switch worktree');
    const branch = branchDisplay();
    return branch ? cur.name + ' · ' + branch + '\n' + cur.path : cur.path;
  };

  return (
    <Popover
      open={open()}
      onOpenChange={({ open: next }) => open.set(next)}
      placement="bottom"
      align={props.align ?? (props.variant === 'card' ? 'end' : 'start')}
      offset={4}
      margin={8}
      style={
        props.variant === 'card' ? { width: '100%', minWidth: 0 } : { minWidth: 0, flexShrink: 1 }
      }
      popupStyle={{
        ...floatingStyle(),
        width: 340,
        maxHeight: Math.min(396, Math.max(180, windowSize().height - 32)),
      }}
      trigger={
        props.variant === 'card' ? (
          <Button
            accessibilityLabel={tr('Switch worktree')}
            tooltip={textTooltip(triggerTooltip)}
            style={{
              width: '100%',
              minWidth: 0,
              minHeight: 44,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: C.raised,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: 8,
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="gitBranch" size={14} color={isOverridden() ? C.accent : C.secondary} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <Text
                  style={[
                    {
                      ...captionTextStyle,
                      color: C.text,
                      fontWeight: '500',
                      flexShrink: 1,
                      minWidth: 0,
                    },
                    { numberOfLines: 1 },
                  ]}
                >
                  {selectedEntry()?.name ?? tr('Switch worktree')}
                </Text>
                <If when={selectedEntry()?.isCurrent === true}>
                  <Text
                    style={{
                      fontSize: 11,
                      lineHeight: 16,
                      color: C.muted,
                      flexShrink: 0,
                    }}
                  >
                    {tr('Current checkout')}
                  </Text>
                </If>
              </View>
              <Text
                style={[
                  { fontSize: 12, lineHeight: 16, color: C.muted, minWidth: 0 },
                  { numberOfLines: 1 },
                ]}
              >
                {branchDisplay()}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <Text style={{ fontSize: 11, lineHeight: 16, color: C.muted }}>
                {formatCount(ordered().length)}
              </Text>
              <Icon name="down" size={12} color={C.muted} />
            </View>
          </Button>
        ) : (
          <Button
            accessibilityLabel={tr('Switch worktree')}
            tooltip={textTooltip(triggerTooltip)}
            style={{
              maxWidth: '100%',
              minWidth: 0,
              height: 28,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: C.card,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: 6,
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="gitBranch" size={13} color={isOverridden() ? C.accent : C.secondary} />
            <Text
              style={[
                {
                  ...captionTextStyle,
                  color: C.text,
                  fontWeight: '500',
                  flexShrink: 1,
                  minWidth: 0,
                },
                { numberOfLines: 1 },
              ]}
            >
              {selectedEntry()?.name ?? tr('Switch worktree')}
            </Text>
            <If when={Boolean(branchDisplay() && branchDisplay() !== selectedEntry()?.name)}>
              <Text
                style={[
                  {
                    fontSize: 12,
                    lineHeight: 16,
                    color: C.muted,
                    flexShrink: 2,
                    minWidth: 0,
                  },
                  { numberOfLines: 1 },
                ]}
              >
                {branchDisplay()}
              </Text>
            </If>
            <Icon name="down" size={12} color={C.muted} />
          </Button>
        )
      }
    >
      <If when={open()}>
        <WorktreeMenu
          entries={ordered}
          activeWorktree={props.activeWorktree}
          onSelect={(path) => {
            open.set(false);
            props.onSelect(path);
          }}
          onClose={() => open.set(false)}
        />
      </If>
    </Popover>
  );
}

function WorktreeMenu(props: {
  entries(): readonly GitWorktreeEntry[];
  activeWorktree(): string | null;
  onSelect(worktreePath: string | null): void;
  onClose(): void;
}) {
  const query = signal('');
  const highlighted = signal(0);
  const scrollY = signal(0);
  const viewportHeight = signal(0);
  let searchInput: { focus(): void } | null = null;
  let scrollNode: ScrollRef | null = null;
  let removeKeys = () => {};
  let didInitialScroll = false;

  cleanup(() => removeKeys());

  const isSelected = (wt: GitWorktreeEntry) => {
    const active = props.activeWorktree();
    return active ? wt.path === active : wt.isCurrent;
  };

  const filtered = computed(() => {
    const q = query().trim().toLowerCase();
    const all = props.entries();
    if (!q) return all;
    return all.filter(
      (wt) =>
        wt.name.toLowerCase().includes(q) ||
        (wt.branch?.toLowerCase().includes(q) ?? false) ||
        wt.path.toLowerCase().includes(q),
    );
  });

  const clampedIndex = () =>
    Math.max(0, Math.min(highlighted(), Math.max(0, filtered().length - 1)));

  const maxListHeight = () => Math.min(324, Math.max(132, windowSize().height - 108));
  const totalContentHeight = () => {
    const count = filtered().length;
    return count === 0 ? 0 : count * ROW_HEIGHT + (count - 1) * ROW_GAP + 4;
  };

  const revealIndex = (idx: number) => {
    const vh = viewportHeight() || maxListHeight();
    const top = idx * ROW_STEP;
    const bottom = top + ROW_HEIGHT + 4;
    if (top < scrollY()) {
      scrollY.set(top);
      scrollNode?.scrollTo({ y: top, animated: false });
    } else if (bottom > scrollY() + vh) {
      const nextY = Math.max(0, bottom - vh);
      scrollY.set(nextY);
      scrollNode?.scrollTo({ y: nextY, animated: false });
    }
  };

  const move = (delta: number) => {
    const list = filtered();
    if (list.length === 0) return;
    const next = Math.max(0, Math.min(list.length - 1, clampedIndex() + delta));
    highlighted.set(next);
    revealIndex(next);
  };

  const activateHighlighted = () => {
    const item = filtered()[clampedIndex()];
    if (item) props.onSelect(item.isCurrent ? null : item.path);
  };

  const initialActiveIdx = props.entries().findIndex((w) => isSelected(w));
  if (initialActiveIdx > 0) highlighted.set(initialActiveIdx);

  const showScrollbar = () => viewportHeight() > 32 && totalContentHeight() > viewportHeight() + 2;

  const thumbMetrics = () => {
    const vh = viewportHeight();
    const ch = totalContentHeight();
    const track = Math.max(16, vh - 8);
    const height = Math.max(24, Math.round((vh / Math.max(1, ch)) * track));
    const maxScroll = Math.max(1, ch - vh);
    const ratio = Math.max(0, Math.min(1, scrollY() / maxScroll));
    const top = 4 + Math.round(ratio * Math.max(0, track - height));
    return { top, height };
  };

  return (
    <View style={{ minHeight: 0, flexShrink: 1 }}>
      <View style={{ ...menuRowStyle(), gap: 8, flexShrink: 0 }}>
        <View
          role="button"
          accessibilityLabel={tr('Filter worktrees…')}
          onPress={() => searchInput?.focus()}
          style={{
            position: 'absolute',
            top: 0,
            right: 36,
            bottom: 0,
            left: 0,
          }}
        />
        <Icon name="search" size={14} color={C.muted} />
        <Input
          ref={(node) => {
            searchInput = node;
            removeKeys();
            if (!node) return;
            const unbind = [
              keymap.bind('up', () => move(-1), { when: 'always', repeat: true, within: node }),
              keymap.bind('down', () => move(1), { when: 'always', repeat: true, within: node }),
              keymap.bind('enter', activateHighlighted, { when: 'always', within: node }),
              keymap.bind('escape', props.onClose, { when: 'always', within: node }),
            ];
            removeKeys = () => unbind.forEach((u) => u());
          }}
          autoFocus
          value={query()}
          onChange={({ value }) => {
            batch(() => {
              query.set(value);
              highlighted.set(0);
              scrollY.set(0);
            });
            scrollNode?.scrollTo({ y: 0, animated: false });
          }}
          onSubmit={activateHighlighted}
          placeholder={tr('Filter worktrees…')}
          accessibilityLabel={tr('Filter worktrees…')}
          style={{
            ...captionTextStyle,
            flex: 1,
            minWidth: 0,
            color: C.text,
            placeholderColor: C.muted,
          }}
        />
        <Text style={{ fontSize: 11, lineHeight: 16, color: C.muted, flexShrink: 0 }}>
          {query().trim().length > 0
            ? `${formatCount(filtered().length)}/${formatCount(props.entries().length)}`
            : formatCount(props.entries().length)}
        </Text>
        <If when={query().length > 0}>
          <Button
            accessibilityLabel={tr('Clear')}
            onPress={() => {
              batch(() => {
                query.set('');
                highlighted.set(0);
                scrollY.set(0);
              });
              scrollNode?.scrollTo({ y: 0, animated: false });
              searchInput?.focus();
            }}
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            hoverStyle={{ backgroundColor: C.floatingRaised }}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="close" size={11} color={C.muted} />
          </Button>
        </If>
      </View>

      <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />

      <If
        when={filtered().length > 0}
        else={
          <View style={{ paddingHorizontal: 12, paddingVertical: 16, alignItems: 'center' }}>
            <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
              {tr('No matching worktrees')}
            </Text>
          </View>
        }
      >
        <View
          onLayout={({ bounds }) => {
            viewportHeight.set(bounds.size.height);
            if (!didInitialScroll && bounds.size.height > 0) {
              didInitialScroll = true;
              if (initialActiveIdx > 0) {
                const targetBottom = initialActiveIdx * ROW_STEP + ROW_HEIGHT + 4;
                if (targetBottom > bounds.size.height) {
                  const targetY = Math.max(0, initialActiveIdx * ROW_STEP - bounds.size.height / 3);
                  scrollY.set(targetY);
                  scrollNode?.scrollTo({ y: targetY, animated: false });
                }
              }
            }
          }}
          style={{ position: 'relative', minHeight: 0, flexShrink: 1 }}
        >
          <Scroll
            ref={(node) => {
              scrollNode = node;
            }}
            onScroll={({ offset }) => scrollY.set(offset.y)}
            style={{
              maxHeight: maxListHeight(),
              minHeight: 0,
              flexShrink: 1,
            }}
          >
            <View
              style={{ gap: ROW_GAP, paddingVertical: 2, paddingRight: showScrollbar() ? 6 : 0 }}
            >
              <Each of={filtered()} key={(wt) => wt.path}>
                {(wt, idx) => {
                  const selected = () => isSelected(wt());
                  const focusedRow = () => clampedIndex() === idx();
                  const subtitle = () => {
                    const b = wt().branch;
                    if (b && b !== wt().name) return b;
                    if (!b) return tr('Detached HEAD') + ' · ' + compactHomePath(wt().path);
                    return compactHomePath(wt().path);
                  };
                  return (
                    <Button
                      accessibilityLabel={wt().name}
                      tooltip={textTooltip(() => wt().path)}
                      onPress={() => props.onSelect(wt().isCurrent ? null : wt().path)}
                      style={{
                        ...menuRowStyle(),
                        minHeight: ROW_HEIGHT,
                        height: ROW_HEIGHT,
                        paddingVertical: 6,
                        backgroundColor: focusedRow() ? C.floatingRaised : undefined,
                      }}
                      hoverStyle={menuRowHoverStyle()}
                      focusStyle={menuRowHoverStyle()}
                    >
                      <Icon name="gitBranch" size={14} color={selected() ? C.accent : C.muted} />
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                            minWidth: 0,
                          }}
                        >
                          <Text
                            style={[
                              {
                                ...captionTextStyle,
                                color: C.text,
                                fontWeight: '500',
                                flexShrink: 1,
                                minWidth: 0,
                              },
                              { numberOfLines: 1 },
                            ]}
                          >
                            {wt().name}
                          </Text>
                          <If when={wt().isCurrent}>
                            <Text
                              style={{
                                fontSize: 11,
                                lineHeight: 16,
                                color: C.muted,
                                flexShrink: 0,
                              }}
                            >
                              {tr('Current checkout')}
                            </Text>
                          </If>
                          <If when={wt().isMain && !wt().isCurrent}>
                            <Text
                              style={{
                                fontSize: 11,
                                lineHeight: 16,
                                color: C.muted,
                                flexShrink: 0,
                              }}
                            >
                              {tr('Main worktree')}
                            </Text>
                          </If>
                        </View>
                        <Text
                          style={[
                            { fontSize: 12, lineHeight: 16, color: C.muted, minWidth: 0 },
                            { numberOfLines: 1 },
                          ]}
                        >
                          {subtitle()}
                        </Text>
                      </View>
                      <If when={selected()}>
                        <Icon name="check" size={14} color={C.accent} />
                      </If>
                    </Button>
                  );
                }}
              </Each>
            </View>
          </Scroll>

          <If when={showScrollbar()}>
            <View
              style={[
                {
                  position: 'absolute',
                  right: 1,
                  top: thumbMetrics().top,
                  width: 3,
                  height: thumbMetrics().height,
                  borderRadius: 2,
                  backgroundColor: C.muted + '75',
                },
                { pointerEvents: 'none' },
              ]}
            />
          </If>
        </View>
      </If>
    </View>
  );
}

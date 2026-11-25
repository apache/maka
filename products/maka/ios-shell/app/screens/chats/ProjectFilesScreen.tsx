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

import { effect, safeAreaInsets, Scroll, signal, Text, View, token } from 'nsh';
import { NavPage } from 'nsh/base';
import { isAvailable, SegmentedControl } from 'nsh/mobile';
import { tr } from '../../locale';
import {
  appendQuoteToDraft,
  fetchGitWorkspaceDiff,
  parseUnifiedDiffFiles,
  type ParsedDiffFile,
} from '../../state/chat';
import { showToast } from '../../state/hostPool';
import { hapticNotification, hapticSelection } from '../../state/preferences';
import { listHostDirectoryChildren, type ScopedSession } from '../../state/sessions';
import { spacing, type } from '../../theme/tokens';
import { BannerNotice, EmptyState, GroupRow, Icon, InsetGroup, ScreenHeader } from '../../ui';

function statusBadgeProps(status: ParsedDiffFile['status']): {
  letter: string;
  color: string;
  bg: string;
} {
  switch (status) {
    case 'added':
      return { letter: 'A', color: token('success'), bg: token('success-tint') };
    case 'deleted':
      return { letter: 'D', color: token('destructive'), bg: token('destructive-tint') };
    case 'renamed':
      return { letter: 'R', color: token('primary'), bg: token('primary-tint') };
    default:
      return { letter: 'M', color: token('warning'), bg: token('warning-tint') };
  }
}

export function ProjectFilesScreen(props: {
  item: ScopedSession;
  onBack: () => void;
  onOpenDiff: (file: ParsedDiffFile) => void;
  onQuotedBackToChat: () => void;
}) {
  const insets = safeAreaInsets();
  const rootId = props.item.rootId;
  const sessionId = props.item.session.id;
  const rootPath = props.item.session.workspace?.path || '';
  const workspaceName =
    props.item.session.workspace?.name ||
    rootPath.split('/').filter(Boolean).pop() ||
    tr('Workspace');

  const segment = signal(0); // 0 = Changes, 1 = Files
  const diffFiles = signal<ParsedDiffFile[]>([]);
  const diffTruncated = signal(false);
  const diffLoading = signal(true);
  const diffError = signal<string | null>(null);

  const currentDir = signal<string>(rootPath);
  const dirStack = signal<string[]>([]);
  const dirEntries = signal<{ name: string; path: string }[]>([]);
  const dirLoading = signal(false);
  const dirError = signal<string | null>(null);

  const loadDiff = async () => {
    diffLoading.set(true);
    diffError.set(null);
    try {
      const res = await fetchGitWorkspaceDiff(rootId, sessionId);
      if (res && typeof res.patch === 'string') {
        diffFiles.set(parseUnifiedDiffFiles(res.patch));
        diffTruncated.set(Boolean(res.truncated));
      } else {
        diffFiles.set([]);
        diffTruncated.set(false);
      }
    } catch (cause) {
      diffError.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      diffLoading.set(false);
    }
  };

  const loadDirectory = async (path: string) => {
    if (!path) {
      dirEntries.set([]);
      return;
    }
    dirLoading.set(true);
    dirError.set(null);
    try {
      const page = await listHostDirectoryChildren(rootId, path);
      dirEntries.set(page.children ?? []);
    } catch (cause) {
      dirError.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      dirLoading.set(false);
    }
  };

  void loadDiff();

  effect(() => {
    if (segment() === 1) {
      void loadDirectory(currentDir());
    }
  });

  const changesLabel = () =>
    diffFiles().length > 0 ? tr('Changes ({count})', { count: diffFiles().length }) : tr('Changes');

  const enterDir = (entry: { name: string; path: string }) => {
    hapticSelection();
    // Heuristic: entries with a file extension can be quoted directly; directories drill down.
    const looksLikeFile = /\.[a-zA-Z0-9]{1,8}$/.test(entry.name);
    if (looksLikeFile) {
      appendQuoteToDraft(rootId, sessionId, entry.path, 1);
      hapticNotification('success');
      showToast(tr('Quoted {path}', { path: entry.name }));
      props.onQuotedBackToChat();
      return;
    }
    dirStack.update((s) => [...s, currentDir()]);
    currentDir.set(entry.path);
  };

  const goUpDir = () => {
    const stack = dirStack();
    if (!stack.length) return;
    hapticSelection();
    const prev = stack[stack.length - 1];
    dirStack.set(stack.slice(0, -1));
    currentDir.set(prev);
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={workspaceName}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      header={<ScreenHeader title={workspaceName} backLabel={tr('Chat')} onBack={props.onBack} />}
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        {/* Segmented Control */}
        <View
          style={{
            paddingHorizontal: spacing.pageX,
            paddingTop: 12,
            paddingBottom: 12,
          }}
        >
          <If
            when={isAvailable}
            else={
              <View
                style={{
                  flexDirection: 'row',
                  backgroundColor: token('surface-muted'),
                  borderRadius: 10,
                  padding: 3,
                  gap: 4,
                }}
              >
                <View
                  role="button"
                  accessibilityLabel={changesLabel()}
                  onPress={() => segment.set(0)}
                  style={{
                    flex: 1,
                    minHeight: 34,
                    borderRadius: 8,
                    backgroundColor: segment() === 0 ? token('surface') : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ ...type.subheadlineMedium, color: token('foreground') }}>
                    {changesLabel()}
                  </Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel={tr('Files')}
                  onPress={() => segment.set(1)}
                  style={{
                    flex: 1,
                    minHeight: 34,
                    borderRadius: 8,
                    backgroundColor: segment() === 1 ? token('surface') : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ ...type.subheadlineMedium, color: token('foreground') }}>
                    {tr('Files')}
                  </Text>
                </View>
              </View>
            }
          >
            <SegmentedControl
              items={[{ title: changesLabel() }, { title: tr('Files') }]}
              selectedIndex={segment()}
              onChange={({ index }) => {
                hapticSelection();
                segment.set(index);
              }}
              style={{ height: 34 }}
            />
          </If>
        </View>

        {/* Tab 0: Git Changes */}
        <If when={segment() === 0}>
          <Scroll
            style={{ flex: 1 }}
            refreshing={diffLoading()}
            onRefresh={() => void loadDiff()}
            contentStyle={{
              flexGrow: 1,
              paddingBottom: Math.max(insets().bottom, 20) + 24,
            }}
          >
            <If when={diffError()}>
              <BannerNotice tone="destructive" title={diffError()!} />
            </If>
            <If when={diffTruncated()}>
              <BannerNotice tone="info" title={tr('Diff truncated for large workspace changes.')} />
            </If>

            <If
              when={diffFiles().length > 0}
              else={
                <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 40 }}>
                  <EmptyState
                    icon="diff"
                    tint="muted"
                    title={diffLoading() ? tr('Loading changes…') : tr('No uncommitted changes')}
                    subtitle={
                      diffLoading()
                        ? tr('Reading git workspace diff from {name}.', {
                            name: props.item.hostName,
                          })
                        : tr(
                            'Modified, added, or deleted files in this workspace will appear here.',
                          )
                    }
                  />
                </View>
              }
            >
              <InsetGroup
                header={tr('Modified files')}
                footer={tr(
                  'Tap any file to inspect its single-column diff and quote lines into chat.',
                )}
              >
                <Each of={diffFiles()} key={(f) => f.path}>
                  {(file, index) => {
                    const b = () => statusBadgeProps(file().status);
                    const fileName = () => file().path.split('/').pop() || file().path;
                    const dirPart = () => {
                      const parts = file().path.split('/');
                      return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
                    };
                    return (
                      <GroupRow
                        leading={
                          <View
                            style={{
                              width: 24,
                              height: 24,
                              borderRadius: 6,
                              borderCurve: 'continuous',
                              backgroundColor: b().bg,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Text
                              style={{
                                ...type.caption,
                                fontWeight: '700',
                                color: b().color,
                              }}
                            >
                              {b().letter}
                            </Text>
                          </View>
                        }
                        title={fileName()}
                        subtitle={dirPart() || undefined}
                        trailing={
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <If when={file().added > 0}>
                              <Text
                                style={{
                                  ...type.caption,
                                  fontWeight: '600',
                                  fontVariant: ['tabular-nums'],
                                  color: token('diff-add-fg'),
                                }}
                              >
                                {'+' + String(file().added)}
                              </Text>
                            </If>
                            <If when={file().deleted > 0}>
                              <Text
                                style={{
                                  ...type.caption,
                                  fontWeight: '600',
                                  fontVariant: ['tabular-nums'],
                                  color: token('diff-del-fg'),
                                }}
                              >
                                {'-' + String(file().deleted)}
                              </Text>
                            </If>
                          </View>
                        }
                        chevron
                        divider={index() < diffFiles().length - 1}
                        accessibilityLabel={tr('Diff: {path}', { path: file().path })}
                        onPress={() => {
                          hapticSelection();
                          props.onOpenDiff(file());
                        }}
                      />
                    );
                  }}
                </Each>
              </InsetGroup>
            </If>
          </Scroll>
        </If>

        {/* Tab 1: Workspace Files */}
        <If when={segment() === 1}>
          <Scroll
            style={{ flex: 1 }}
            refreshing={dirLoading()}
            onRefresh={() => void loadDirectory(currentDir())}
            contentStyle={{
              flexGrow: 1,
              paddingBottom: Math.max(insets().bottom, 20) + 24,
            }}
          >
            <If when={dirError()}>
              <BannerNotice tone="destructive" title={dirError()!} />
            </If>

            <If when={dirStack().length > 0}>
              <InsetGroup>
                <GroupRow
                  leading={<Icon name="chevronLeft" color={token('primary')} size={18} />}
                  title={tr('Parent directory')}
                  subtitle={currentDir()}
                  tone="primary"
                  onPress={goUpDir}
                />
              </InsetGroup>
            </If>

            <If
              when={dirEntries().length > 0}
              else={
                <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 40 }}>
                  <EmptyState
                    icon="folder"
                    tint="muted"
                    title={dirLoading() ? tr('Loading files…') : tr('Folder is empty')}
                    subtitle={currentDir() || tr('No workspace path configured for this chat.')}
                  />
                </View>
              }
            >
              <InsetGroup
                header={currentDir() || tr('Files')}
                footer={tr('Tap a folder to browse or tap a file to quote it into chat.')}
              >
                <Each of={dirEntries()} key={(e) => e.path}>
                  {(entry, index) => {
                    const isFile = () => /\.[a-zA-Z0-9]{1,8}$/.test(entry().name);
                    return (
                      <GroupRow
                        leading={
                          <Icon
                            name={isFile() ? 'file' : 'folder'}
                            color={isFile() ? token('muted-foreground') : token('primary')}
                            size={18}
                          />
                        }
                        title={entry().name}
                        chevron={!isFile()}
                        divider={index() < dirEntries().length - 1}
                        onPress={() => enterDir(entry())}
                      />
                    );
                  }}
                </Each>
              </InsetGroup>
            </If>
          </Scroll>
        </If>
      </View>
    </NavPage>
  );
}

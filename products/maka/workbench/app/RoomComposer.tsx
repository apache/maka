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
  effect,
  keymap,
  Overlay,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
  type InputRef,
  type ScrollRef,
  type ViewRef,
} from 'nsh';
import { Button, Input } from 'nsh/base';
import type {
  AgentRoomMember,
  AgentRoomMessage,
  AgentSendDelivery,
  AgentSendResult,
  AgentSession,
} from '../../../../packages/plugin-sdk/src/index.js';
import {
  useHost,
  loadDraft,
  saveDraft,
  reserveSend,
  confirmSend,
  recoverSend,
  retrySend,
  dismissSend,
  pendingSends,
  type SendOperation,
} from './host';
import { createAttachmentDraft } from './attachmentDraft';
import { projectComposerAttachments } from './composerSession';
import { createComposerPaste } from './composerPaste';
import { DraftAttachments } from './Attachments';
import type { ImagePreview } from './ImageThumbnail';
import { SkillInput } from './SkillInput';
import type { ComposerEditor } from './ComposerEditor';
import { Icon } from './Icon';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlFocusStyle,
  floatingStyle,
  inputTextStyle,
} from './ui';
import { tr } from './locale';
import {
  buildRoomMentionChoices,
  extractInlineMentionIds,
  formatInlineMention,
  formatRoomPreviewText,
  roomAuthorSession,
  roomAvatarColor,
  roomAvatarInitial,
  roomMentionAt,
  roomResult,
  stripInlineMention,
  workspaceTailName,
  type RoomMentionChoice,
} from './roomMessage';
import { ComposerShelf, ComposerShelfRow } from './Feedback';
import { LoadingIndicator } from './Loading';
import { motionEnabled } from './roomMotion';

export type RoomComposerHandle = { flush(): Promise<void>; reply(message: AgentRoomMessage): void };

type MentionSection = 'all' | 'members' | 'rooms' | 'others';

function choiceSection(entry: RoomMentionChoice): MentionSection {
  if (entry.kind === 'all') return 'all';
  if (entry.kind === 'room') return 'rooms';
  return entry.isMember ? 'members' : 'others';
}

export function RoomComposer(props: {
  sessionId: string;
  members(): readonly AgentRoomMember[];
  waitingMembers?(): readonly AgentRoomMember[];
  streamError?(): string;
  retryStream?(): void;
  name(id: string): string;
  resolveNames(ids: string[]): Promise<void>;
  message(id: string): AgentRoomMessage | undefined;
  searchSessions(query: string): Promise<AgentSession[]>;
  openAgent(id: string): void;
  posted(): Promise<void>;
  preview(image: ImagePreview): void;
  attach(handle: RoomComposerHandle | null): void;
}) {
  const host = useHost();
  const client = host.session(props.sessionId);
  const text = signal('');
  // Extra explicit mentions (e.g. from reply) in addition to inline [@Title](maka://session/<id>) tokens.
  const extraMentions = signal<string[]>([]);
  const replyTo = signal<string | null>(null);
  const replyQuote = signal<AgentRoomMessage | null>(null);
  const delivery = signal<AgentSendDelivery>('steer');
  const ready = signal(false);
  const busy = signal(false);
  const error = signal('');
  const pending = signal<SendOperation | null>(null);
  const choosing = signal(false);
  const query = signal('');
  const choices = signal<AgentSession[]>([]);
  const choice = signal(0);
  const searching = signal(false);
  const selection = signal({ start: 0, end: 0 });
  const dismissedAt = signal<number | null>(null);
  const editor = signal<ComposerEditor | null>(null);
  const searchField = signal<InputRef | null>(null);
  const composerCard = signal<ViewRef | null>(null);
  let alive = true;
  let revision = 0;
  let dirty = false;
  let saving: Promise<void> | null = null;
  let searchGeneration = 0;
  let pickerScroll: ScrollRef | undefined;
  let pickerScrollY = 0;
  let pickerViewportHeight = 0;
  const rowBounds = new Map<string, { y: number; height: number }>();

  const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
  const attachments = createAttachmentDraft({
    sessionId: props.sessionId,
    client,
    changed,
    focus: () => editor()?.focus(),
  });
  const projection = projectComposerAttachments(attachments, host);
  const pasteOwner = {
    sessionId: props.sessionId,
    draft: text,
    editable: () => ready() && !busy() && pending() === null,
    attachments: projection,
  };
  const paste = createComposerPaste({
    owner: () => pasteOwner,
    active: () => true,
    editor,
    selection,
    composing: () => editor()?.composing() ?? false,
    dismiss: () => dismissPicker(),
  });

  // Single source of truth for effective mentions: inline tokens in text + explicit extra chips.
  const effectiveMentions = () => {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const id of extractInlineMentionIds(text())) {
      if (id !== props.sessionId && !seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
    for (const id of extraMentions()) {
      if (id !== props.sessionId && !seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
    return merged;
  };

  const snapshot = () => ({
    text: text(),
    mentions: effectiveMentions(),
    replyTo: replyTo(),
    ...attachments.snapshot(),
  });

  function changed() {
    dirty = true;
    if (ready())
      void flush().catch((reason) => {
        if (alive) error.set(describe(reason));
      });
  }

  function flush(): Promise<void> {
    if (saving) return saving;
    if (!ready() || !dirty) return Promise.resolve();
    saving = (async () => {
      while (dirty) {
        dirty = false;
        const edit = snapshot();
        try {
          const saved = await saveDraft(client, revision, edit);
          revision = saved.revision;
          attachments.saved(edit);
        } catch (reason) {
          dirty = true;
          throw reason;
        }
      }
    })().finally(() => {
      saving = null;
    });
    return saving;
  }

  let hydrationPending = false;
  const hydrateRestoredDraft = async () => {
    hydrationPending = true;
    const messageId = replyTo();
    if (messageId && !props.message(messageId) && replyQuote()?.id !== messageId) {
      const history = await host.query('agent', 'history', {
        sessionId: props.sessionId,
        position: { kind: 'message', messageId },
      });
      if (history.kind !== 'room') throw new Error('Expected Room history.');
      if (alive && replyTo() === messageId)
        replyQuote.set(history.page.items.find((message) => message.id === messageId) ?? null);
    }
    if (!alive) return;
    hydrationPending = false;
    void attachments.start();
  };

  const restore = async () => {
    const [draft, operations] = await Promise.all([loadDraft(client), pendingSends(client)]);
    if (!alive) return;
    revision = draft.revision;
    const inlineIds = new Set(extractInlineMentionIds(draft.text));
    const extras = (draft.mentions ?? []).filter((id) => !inlineIds.has(id));
    batch(() => {
      text.set(draft.text);
      extraMentions.set(extras);
      replyTo.set(draft.replyTo ?? null);
      attachments.restore(draft.attachments);
      pending.set(operations[0] ?? null);
      ready.set(true);
    });
    void props.resolveNames(draft.mentions ?? []).catch(() => {});
    await hydrateRestoredDraft();
  };
  void restore().catch((reason) => {
    if (alive) error.set(describe(reason));
  });

  const addExtraMention = (id: string) => {
    if (id === props.sessionId) return;
    if (!effectiveMentions().includes(id)) extraMentions.set([...extraMentions(), id]);
    changed();
  };

  const removeMention = (id: string) => {
    const stripped = stripInlineMention(text(), id);
    batch(() => {
      if (stripped !== text()) text.set(stripped);
      extraMentions.set(extraMentions().filter((value) => value !== id));
    });
    changed();
  };

  const handle: RoomComposerHandle = {
    flush,
    reply(message) {
      if (!ready()) return;
      replyTo.set(message.id);
      replyQuote.set(message);
      const sender = roomAuthorSession(message);
      if (sender) addExtraMention(sender);
      changed();
      editor()?.focus();
    },
  };
  props.attach(handle);
  cleanup(() => {
    alive = false;
    searchGeneration++;
    props.attach(null);
  });

  const refreshPending = async () => {
    const operations = await pendingSends(client);
    if (alive) pending.set(operations[0] ?? null);
  };

  const accept = async (reply: unknown) => {
    const result = roomResult<AgentSendResult>(reply);
    if (result.kind !== 'posted')
      throw new Error(result.kind === 'rejected' ? result.reason : result.kind);
    const draft = await loadDraft(client);
    if (!alive) return;
    const inlineIds = new Set(extractInlineMentionIds(draft.text));
    batch(() => {
      revision = draft.revision;
      text.set(draft.text);
      extraMentions.set((draft.mentions ?? []).filter((id) => !inlineIds.has(id)));
      replyTo.set(draft.replyTo ?? null);
      if (!draft.replyTo) replyQuote.set(null);
      delivery.set('steer');
      attachments.restore(draft.attachments);
      pending.set(null);
      error.set('');
    });
    await props.posted();
    editor()?.focus();
  };

  const send = async () => {
    if (!ready() || busy() || pending() || (!text().trim() && !attachments.ids().length)) return;
    const blocked = attachments.blocked();
    if (blocked) {
      error.set(blocked);
      return;
    }
    busy.set(true);
    error.set('');
    try {
      await flush();
      const id = await reserveSend(client, revision, { delivery: delivery() });
      await accept((await confirmSend(client, id)).reply);
    } catch (reason) {
      if (alive) error.set(describe(reason));
      await refreshPending();
    } finally {
      if (alive) busy.set(false);
    }
  };

  const recover = async () => {
    const original = pending();
    if (!original || busy()) return;
    busy.set(true);
    error.set('');
    try {
      const reply = await recoverSend(client, original.id);
      const receipt = reply.receipt;
      const result =
        receipt.kind === 'recorded' &&
        receipt.outcome.kind === 'returned' &&
        receipt.outcome.result.kind === 'success'
          ? (receipt.outcome.result.value as AgentSendResult)
          : null;
      if (result?.kind === 'posted') await accept(reply);
      else if (
        receipt.kind === 'recorded' &&
        (receipt.outcome.kind === 'not_executed' || result?.kind === 'rejected')
      ) {
        const id = await retrySend(client, original.id, { delivery: delivery() });
        await accept((await confirmSend(client, id)).reply);
      } else roomResult(reply);
    } catch (reason) {
      if (alive) error.set(describe(reason));
    } finally {
      await refreshPending();
      if (alive) busy.set(false);
    }
  };

  const removePending = async () => {
    const original = pending();
    if (!original || busy()) return;
    busy.set(true);
    try {
      await dismissSend(client, original.id);
      await refreshPending();
      error.set('');
    } catch (reason) {
      if (alive) error.set(describe(reason));
    } finally {
      if (alive) busy.set(false);
    }
  };

  const rawTypedMention = () => roomMentionAt(text(), selection());
  const typedMention = () => {
    const token = rawTypedMention();
    if (!token) return null;
    if (dismissedAt() !== null && dismissedAt() === token.start) return null;
    return token;
  };
  const pickerOpen = () => choosing() || typedMention() !== null;
  const pickerQuery = () => (choosing() ? query() : (typedMention()?.query ?? ''));

  effect(() => {
    const raw = rawTypedMention();
    if (dismissedAt() !== null && (!raw || raw.start !== dismissedAt())) {
      dismissedAt.set(null);
    }
  });

  const dismissPicker = () => {
    const raw = rawTypedMention();
    batch(() => {
      choosing.set(false);
      query.set('');
      if (raw) dismissedAt.set(raw.start);
    });
  };

  effect(() => {
    const opened = pickerOpen();
    const needle = pickerQuery();
    const generation = ++searchGeneration;
    choice.set(0);
    if (!opened) {
      searching.set(false);
      pickerScrollY = 0;
      pickerViewportHeight = 0;
      rowBounds.clear();
      return;
    }
    searching.set(true);
    void props
      .searchSessions(needle)
      .then((items) => {
        if (alive && generation === searchGeneration) choices.set(items);
      })
      .catch((reason) => {
        if (alive && generation === searchGeneration) error.set(describe(reason));
      })
      .finally(() => {
        if (alive && generation === searchGeneration) searching.set(false);
      });
  });

  const visibleChoices = (): RoomMentionChoice[] =>
    buildRoomMentionChoices({
      roomId: props.sessionId,
      members: props.members(),
      sessions: choices(),
      alreadyMentioned: new Set(effectiveMentions()),
      query: pickerQuery(),
      allLabel: tr('All room members'),
      allKeywords: tr('room.mention_all_keywords')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    });

  effect(() => {
    const len = visibleChoices().length;
    if (len === 0) choice.set(0);
    else if (choice() >= len) choice.set(len - 1);
  });

  const moveChoice = (delta: number) => {
    const list = visibleChoices();
    if (list.length === 0) return;
    const next = Math.max(0, Math.min(choice() + delta, list.length - 1));
    choice.set(next);
    const target = list[next];
    if (!target || !pickerScroll || pickerViewportHeight <= 0) return;
    const bounds = rowBounds.get(target.id);
    if (!bounds) return;
    if (bounds.y < pickerScrollY) {
      pickerScroll.scrollTo({ y: bounds.y, animated: false });
    } else if (bounds.y + bounds.height > pickerScrollY + pickerViewportHeight) {
      pickerScroll.scrollTo({
        y: bounds.y + bounds.height - pickerViewportHeight,
        animated: false,
      });
    }
  };

  const selectChoice = async (entry: RoomMentionChoice) => {
    const token = choosing() ? null : typedMention();
    const current = text();
    const inserted =
      entry.kind === 'all'
        ? (() => {
            const membersById = new Map(props.members().map((m) => [m.sessionId, m.title]));
            return entry.ids
              .map((id) => formatInlineMention(id, membersById.get(id) ?? props.name(id)))
              .join('');
          })()
        : formatInlineMention(entry.id, entry.title, entry.kind);

    if (token) {
      const sep = token.start > 0 && !/\s/.test(current[token.start - 1]!) ? ' ' : '';
      const replaced = await editor()?.replaceRange({
        expectedText: current,
        expectedSelection: selection(),
        start: token.start,
        end: token.end,
        text: sep + inserted,
      });
      if (!replaced) return;
    } else if (entry.kind === 'all') {
      const sep = current.length > 0 && !/\s$/.test(current) ? ' ' : '';
      text.set(current + sep + inserted);
    } else {
      const sel = selection();
      if (sel.start >= 0 && sel.start <= current.length && sel.end <= current.length) {
        const before = current.slice(0, sel.start);
        const after = current.slice(sel.end);
        const sep = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
        text.set(before + sep + inserted + after);
      } else {
        const sep = current.length > 0 && !/\s$/.test(current) ? ' ' : '';
        text.set(current + sep + inserted);
      }
    }
    batch(() => {
      choosing.set(false);
      query.set('');
      dismissedAt.set(null);
    });
    changed();
    editor()?.focus();
  };

  effect(() => {
    const node = editor();
    if (!node || !pickerOpen()) return;
    const cleanups = [
      node.bindKey('down', () => moveChoice(1)),
      node.bindKey('up', () => moveChoice(-1)),
      node.bindKey('tab', () => {
        const item = visibleChoices()[choice()];
        if (item) void selectChoice(item);
      }),
    ];
    return () => {
      for (const stop of cleanups) stop();
    };
  });

  effect(() => {
    const input = searchField();
    if (!input || !choosing()) return;
    const cleanups = [
      keymap.bind('down', () => moveChoice(1), { when: 'always', within: input }),
      keymap.bind('up', () => moveChoice(-1), { when: 'always', within: input }),
      keymap.bind(
        'tab',
        () => {
          const item = visibleChoices()[choice()];
          if (item) void selectChoice(item);
        },
        { when: 'always', within: input },
      ),
      keymap.bind('escape', () => dismissPicker(), { when: 'always', within: input }),
    ];
    return () => {
      for (const stop of cleanups) stop();
    };
  });

  const openPicker = () => {
    const next = !choosing();
    choosing.set(next);
    query.set('');
    dismissedAt.set(null);
  };

  const hasBusyTarget = () => {
    const memberMap = new Map(props.members().map((m) => [m.sessionId, m.activity]));
    return effectiveMentions().some((id) => memberMap.get(id) === 'working');
  };

  const duplicateTitles = () => {
    const counts = new Map<string, number>();
    for (const row of visibleChoices()) {
      if (row.kind === 'agent' || row.kind === 'room') {
        const key = `${row.kind}:${row.title}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  };

  const canSend = () =>
    ready() &&
    !busy() &&
    pending() === null &&
    (Boolean(text().trim()) || attachments.ids().length > 0);

  const streamError = () => props.streamError?.() ?? '';
  const waiting = () => props.waitingMembers?.() ?? [];
  const hasFailure = () => Boolean(streamError() || error() || pending());
  const hasWaiting = () => waiting().length > 0;
  const failureMessage = () =>
    error() || (pending() ? tr('Could not send to the room.') : streamError());
  const pendingPreview = () => {
    const draft = pending()?.correlation.draft;
    if (!draft) return '';
    const mentions = (draft.mentions ?? []).map((id) => '@' + props.name(id)).join(' ');
    return [draft.text.trim(), mentions].filter(Boolean).join(' ');
  };
  const retryFailure = () => {
    if (pending()) {
      void recover();
      return;
    }
    if (error()) {
      const retryAction = !ready()
        ? restore()
        : hydrationPending
          ? hydrateRestoredDraft().then(() => flush())
          : flush();
      void retryAction
        .then(() => {
          if (alive) error.set('');
        })
        .catch((reason) => {
          if (alive) error.set(describe(reason));
        });
      return;
    }
    props.retryStream?.();
  };

  return (
    <View
      style={{
        width: '100%',
        maxWidth: 960,
        alignSelf: 'center',
        gap: 6,
        paddingHorizontal: 24,
        paddingBottom: 20,
      }}
    >
      <If when={pickerOpen() && composerCard() !== null}>
        <Overlay
          anchor={composerCard()!}
          placement="top"
          align="start"
          offset={8}
          margin={16}
          onPressOutside={() => dismissPicker()}
          onCancel={() => dismissPicker()}
          accessibilityLabel={tr('Mention a session')}
          style={{
            ...floatingStyle(),
            width: Math.min(460, Math.max(240, windowSize().width - 48)),
            maxHeight: Math.min(380, Math.max(160, windowSize().height - 120)),
            padding: 8,
            gap: 4,
          }}
        >
          <If when={choosing()}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderBottomWidth: 1,
                borderBottomColor: C.line,
                marginBottom: 4,
              }}
            >
              <Icon name="search" size={14} color={C.muted} />
              <Input
                ref={(node) => searchField.set(node)}
                autoFocus
                accessibilityLabel={tr('Search sessions…')}
                placeholder={tr('Search sessions…')}
                value={query()}
                onChange={({ value }) => query.set(value)}
                onSubmit={() => {
                  const item = visibleChoices()[choice()];
                  if (item) void selectChoice(item);
                }}
                style={{ ...inputTextStyle, color: C.text, flex: 1, paddingVertical: 4 }}
              />
            </View>
          </If>
          <If when={searching() && visibleChoices().length === 0}>
            <View style={{ padding: 10 }}>
              <LoadingIndicator />
            </View>
          </If>
          <If when={visibleChoices().length > 0}>
            <Scroll
              ref={(node) => {
                pickerScroll = node;
              }}
              style={{
                maxHeight: Math.min(310, Math.max(120, windowSize().height - 190)),
                minHeight: 0,
                flexShrink: 1,
                flexGrow: 0,
              }}
              contentStyle={{ gap: 2 }}
              onLayout={({ bounds }) => {
                pickerViewportHeight = bounds.size.height;
              }}
              onScroll={(event) => {
                pickerScrollY = event.offset.y;
                pickerViewportHeight = event.size.height;
              }}
            >
              <Each of={visibleChoices()} key={(entry) => entry.id}>
                {(entry, index) => {
                  const sectionHeader = () => {
                    const section = choiceSection(entry());
                    if (section === 'all') return null;
                    const prev = index() > 0 ? visibleChoices()[index() - 1] : undefined;
                    if (prev && choiceSection(prev) === section) return null;
                    if (section === 'members') return tr('Room members');
                    if (section === 'rooms') return tr('Rooms');
                    return tr('Other conversations');
                  };
                  const presetName = () => {
                    const cur = entry();
                    return cur.kind === 'agent' ? cur.presetName : null;
                  };
                  const duplicateWorkspace = () => {
                    const cur = entry();
                    if (cur.kind === 'all' || !cur.workspacePath) return '';
                    return (duplicateTitles().get(`${cur.kind}:${cur.title}`) ?? 0) > 1
                      ? workspaceTailName(cur.workspacePath)
                      : '';
                  };
                  const activity = () => {
                    const cur = entry();
                    return cur.kind === 'agent' ? cur.activity : 'idle';
                  };
                  return (
                    <View
                      style={{ gap: 2 }}
                      onLayout={({ bounds }) => {
                        rowBounds.set(entry().id, {
                          y: bounds.origin.y,
                          height: bounds.size.height,
                        });
                      }}
                    >
                      <If when={sectionHeader() !== null}>
                        <Text
                          style={{
                            ...captionTextStyle,
                            color: C.muted,
                            paddingHorizontal: 10,
                            paddingTop: index() > 0 ? 6 : 4,
                          }}
                        >
                          {sectionHeader()!}
                        </Text>
                      </If>
                      <Button
                        accessibilityLabel={entry().title}
                        onPress={() => void selectChoice(entry())}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor: index() === choice() ? C.surface : 'transparent',
                        }}
                        hoverStyle={{ backgroundColor: C.surface }}
                        focusStyle={controlFocusStyle()}
                      >
                        <If
                          when={entry().kind === 'all'}
                          else={
                            <If
                              when={entry().kind === 'room'}
                              else={
                                <View
                                  style={{
                                    width: 22,
                                    height: 22,
                                    borderRadius: 11,
                                    backgroundColor: roomAvatarColor(entry().id),
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                  }}
                                >
                                  <Text
                                    style={{ fontSize: 11, fontWeight: '600', color: '#FFFFFF' }}
                                  >
                                    {roomAvatarInitial(entry().title)}
                                  </Text>
                                </View>
                              }
                            >
                              <View
                                style={{
                                  width: 22,
                                  height: 22,
                                  borderRadius: 6,
                                  backgroundColor: C.surface,
                                  borderWidth: 1,
                                  borderColor: C.line,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <Icon name="symbol" size={12} color={C.secondary} />
                              </View>
                            </If>
                          }
                        >
                          <View
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: 11,
                              backgroundColor: C.accent,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Icon name="rooms" size={12} color={C.onAccent} />
                          </View>
                        </If>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text
                              style={[{ ...bodyTextStyle, color: C.text }, { numberOfLines: 1 }]}
                            >
                              {entry().title}
                            </Text>
                            <If when={Boolean(presetName())}>
                              <Text style={{ ...captionTextStyle, color: C.muted }}>
                                {presetName()!}
                              </Text>
                            </If>
                          </View>
                          <If when={Boolean(duplicateWorkspace())}>
                            <Text
                              style={[
                                { ...captionTextStyle, color: C.muted },
                                { numberOfLines: 1 },
                              ]}
                            >
                              {duplicateWorkspace()}
                            </Text>
                          </If>
                        </View>
                        <If when={activity() !== 'idle'}>
                          <View
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: 4,
                              backgroundColor: activity() === 'waiting' ? C.warning : C.accent,
                            }}
                          />
                        </If>
                      </Button>
                    </View>
                  );
                }}
              </Each>
            </Scroll>
          </If>
          <If when={!searching() && visibleChoices().length === 0}>
            <Text style={{ ...captionTextStyle, color: C.muted, padding: 10 }}>
              {tr('No matching sessions')}
            </Text>
          </If>
        </Overlay>
      </If>

      <View style={{ flexShrink: 0 }}>
        <If when={hasFailure() || hasWaiting()}>
          <ComposerShelf inset={20}>
            <If when={hasFailure()}>
              <ComposerShelfRow
                tone="danger"
                message={failureMessage()}
                detail={pending() ? pendingPreview() : undefined}
                divided={hasWaiting()}
                action={{
                  label: tr('Retry'),
                  primary: true,
                  disabled: busy(),
                  onPress: retryFailure,
                }}
                onDismiss={
                  pending()
                    ? () => {
                        if (!busy()) void removePending();
                      }
                    : undefined
                }
                dismissLabel={tr('Dismiss message status')}
              />
            </If>
            <If when={hasWaiting()}>
              <ComposerShelfRow
                tone="warning"
                message={tr('Waiting for your input', {
                  names: waiting()
                    .map((m) => m.title)
                    .join(', '),
                })}
                action={{
                  label: tr('Open to respond'),
                  primary: true,
                  onPress: () => {
                    const first = waiting()[0];
                    if (first) props.openAgent(first.sessionId);
                  },
                }}
              />
            </If>
          </ComposerShelf>
        </If>
        <View
          ref={(node) => composerCard.set(node)}
          style={{ backgroundColor: C.card, borderRadius: 20, padding: 16, gap: 12 }}
        >
          <If when={replyTo() !== null}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                borderLeftWidth: 2,
                borderLeftColor: C.accent,
                paddingLeft: 10,
              }}
            >
              <Text
                style={[{ ...captionTextStyle, color: C.secondary, flex: 1 }, { numberOfLines: 2 }]}
              >
                {formatRoomPreviewText(
                  (props.message(replyTo()!) ?? replyQuote())?.content.text ?? '',
                ) || tr('View replied message')}
              </Text>
              <Button
                accessibilityLabel={tr('Cancel reply')}
                disabled={busy() || pending() !== null}
                onPress={() => {
                  replyTo.set(null);
                  replyQuote.set(null);
                  changed();
                }}
                style={controlStyle}
                hoverStyle={{ backgroundColor: C.surface }}
              >
                <Icon name="close" color={C.muted} />
              </Button>
            </View>
          </If>

          <If
            when={(() => {
              const inline = new Set(extractInlineMentionIds(text()));
              return extraMentions().some((id) => !inline.has(id));
            })()}
          >
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Each
                of={(() => {
                  const inline = new Set(extractInlineMentionIds(text()));
                  return extraMentions().filter((id) => !inline.has(id));
                })()}
                key={(id) => id}
              >
                {(id) => (
                  <Button
                    accessibilityLabel={tr('Remove mention {name}', { name: props.name(id()) })}
                    onPress={() => removeMention(id())}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 8,
                      backgroundColor: C.surface,
                    }}
                    hoverStyle={{ backgroundColor: C.raised }}
                    focusStyle={controlFocusStyle()}
                  >
                    <View
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 7,
                        backgroundColor: roomAvatarColor(id()),
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 9, fontWeight: '600', color: '#FFFFFF' }}>
                        {roomAvatarInitial(props.name(id()))}
                      </Text>
                    </View>
                    <Text style={{ ...captionTextStyle, color: C.accentText }}>
                      @{props.name(id())}
                    </Text>
                    <Icon name="close" size={12} color={C.muted} />
                  </Button>
                )}
              </Each>
            </View>
          </If>

          <DraftAttachments draft={projection} preview={props.preview} />

          <SkillInput
            ref={(node) => editor.set(node)}
            testID="room-message-input"
            accessibilityLabel={tr('Message room')}
            value={text()}
            readonly={!ready() || busy() || pending() !== null}
            placeholder={tr('Message this room…')}
            autoFocus={false}
            style={{ minHeight: 48, maxHeight: 200 }}
            onChange={({ value }) => {
              text.set(value);
              changed();
            }}
            onSelectionChange={(value) => selection.set(value)}
            onOpenSessionReference={({ sessionId }) => props.openAgent(sessionId)}
            onSubmit={() => {
              const candidate = pickerOpen() ? visibleChoices()[choice()] : undefined;
              if (candidate) void selectChoice(candidate);
              else void send();
            }}
            onEscape={() => dismissPicker()}
            onPaste={(event) => paste.paste(pasteOwner, event)}
            onFileDrop={(event) => paste.drop(pasteOwner, event)}
            onFocus={() => paste.focus(pasteOwner)}
            onBlur={() => paste.blur(pasteOwner)}
          />

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Button
              accessibilityLabel={tr('Attach files…')}
              onPress={() =>
                attachments.open({ owner: props.sessionId, value: !attachments.picker() })
              }
              disabled={!ready() || busy() || pending() !== null}
              style={controlStyle}
              hoverStyle={{ backgroundColor: C.surface }}
              focusStyle={controlFocusStyle()}
            >
              <Icon name="plus" color={C.secondary} />
            </Button>
            <Button
              accessibilityLabel={tr('Mention a session')}
              onPress={openPicker}
              disabled={!ready() || busy() || pending() !== null}
              style={controlStyle}
              hoverStyle={{ backgroundColor: C.surface }}
              focusStyle={controlFocusStyle()}
            >
              <Text style={{ ...bodyTextStyle, color: choosing() ? C.accentText : C.secondary }}>
                @
              </Text>
            </Button>
            <If when={hasBusyTarget()}>
              <Button
                accessibilityLabel={
                  delivery() === 'queue' ? tr('Queue delivery') : tr('Steer delivery')
                }
                onPress={() => delivery.set(delivery() === 'queue' ? 'steer' : 'queue')}
                disabled={busy() || pending() !== null}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 10,
                  backgroundColor: delivery() === 'queue' ? C.surface : 'transparent',
                  borderWidth: 1,
                  borderColor: delivery() === 'queue' ? C.accent : C.line,
                }}
                hoverStyle={{ backgroundColor: C.surface }}
                focusStyle={controlFocusStyle()}
              >
                <Icon
                  name={delivery() === 'queue' ? 'queue' : 'activity'}
                  size={13}
                  color={delivery() === 'queue' ? C.accentText : C.secondary}
                />
                <Text
                  style={{
                    ...captionTextStyle,
                    color: delivery() === 'queue' ? C.accentText : C.secondary,
                  }}
                >
                  {delivery() === 'queue' ? tr('Queue delivery') : tr('Steer delivery')}
                </Text>
              </Button>
            </If>
            <View style={{ flex: 1 }} />
            <Button
              accessibilityLabel={tr('Send message')}
              onPress={() => void send()}
              disabled={!canSend()}
              class={motionEnabled() ? 'transition-colors duration-150' : undefined}
              style={{
                width: 34,
                height: 34,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 17,
                backgroundColor: canSend() ? C.accent : C.surface,
              }}
              activeStyle={motionEnabled() ? { transform: [{ scale: 0.92 }] } : undefined}
              focusStyle={controlFocusStyle()}
            >
              <If
                when={busy()}
                else={<Icon name="send" color={canSend() ? C.onAccent : C.muted} />}
              >
                <LoadingIndicator color={C.muted} />
              </If>
            </Button>
          </View>
        </View>
      </View>
    </View>
  );
}

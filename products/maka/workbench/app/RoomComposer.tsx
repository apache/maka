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

import { batch, cleanup, effect, signal, Text, View, type InputRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import type {
  AgentRoomMessage,
  AgentSession,
  AgentSendResult,
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
  inputTextStyle,
} from './ui';
import { tr } from './locale';
import { roomAuthorSession, roomMentionAt, roomResult } from './roomMessage';
import { LoadingIndicator } from './Loading';

export type RoomComposerHandle = { flush(): Promise<void>; reply(message: AgentRoomMessage): void };

export function RoomComposer(props: {
  sessionId: string;
  name(id: string): string;
  resolveNames(ids: string[]): Promise<void>;
  message(id: string): AgentRoomMessage | undefined;
  searchSessions(query: string): Promise<AgentSession[]>;
  posted(): Promise<void>;
  preview(image: ImagePreview): void;
  attach(handle: RoomComposerHandle | null): void;
}) {
  const host = useHost();
  const client = host.session(props.sessionId);
  const text = signal('');
  const mentions = signal<string[]>([]);
  const replyTo = signal<string | null>(null);
  const replyQuote = signal<AgentRoomMessage | null>(null);
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
  const editor = signal<ComposerEditor | null>(null);
  let alive = true;
  let revision = 0;
  let dirty = false;
  let saving: Promise<void> | null = null;
  let searchGeneration = 0;
  let searchField: InputRef | null = null;
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
    dismiss: () => choosing.set(false),
  });
  const snapshot = () => ({
    text: text(),
    mentions: [...mentions()],
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
  const restore = async () => {
    const [draft, operations] = await Promise.all([loadDraft(client), pendingSends(client)]);
    if (!alive) return;
    revision = draft.revision;
    batch(() => {
      text.set(draft.text);
      mentions.set(draft.mentions ?? []);
      replyTo.set(draft.replyTo ?? null);
      attachments.restore(draft.attachments);
      pending.set(operations[0] ?? null);
      ready.set(true);
    });
    void props.resolveNames(draft.mentions ?? []).catch((reason) => {
      if (alive) error.set(describe(reason));
    });
    if (draft.replyTo && !props.message(draft.replyTo)) {
      const messageId = draft.replyTo;
      const history = await host.query('agent', 'history', {
        sessionId: props.sessionId,
        position: { kind: 'message', messageId },
      });
      if (history.kind !== 'room') throw new Error('Expected Room history.');
      if (alive && replyTo() === messageId)
        replyQuote.set(history.page.items.find((message) => message.id === messageId) ?? null);
    }
    void attachments.start();
  };
  void restore().catch((reason) => {
    if (alive) error.set(describe(reason));
  });
  const mention = (id: string) => {
    if (!mentions().includes(id)) mentions.set([...mentions(), id]);
    changed();
  };
  const handle: RoomComposerHandle = {
    flush,
    reply(message) {
      if (!ready()) return;
      replyTo.set(message.id);
      replyQuote.set(message);
      const sender = roomAuthorSession(message);
      if (sender) mention(sender);
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
    batch(() => {
      revision = draft.revision;
      text.set(draft.text);
      mentions.set(draft.mentions ?? []);
      replyTo.set(draft.replyTo ?? null);
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
      const id = await reserveSend(client, revision, { delivery: 'steer' });
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
        const id = await retrySend(client, original.id, { delivery: 'steer' });
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
  const typedMention = () => roomMentionAt(text(), selection());
  const pickerOpen = () => choosing() || typedMention() !== null;
  const pickerQuery = () => (choosing() ? query() : (typedMention()?.query ?? ''));
  effect(() => {
    const opened = pickerOpen();
    const needle = pickerQuery();
    const generation = ++searchGeneration;
    choice.set(0);
    if (!opened) {
      searching.set(false);
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
  const candidates = () => choices().filter((session) => !mentions().includes(session.id));
  const selectMention = async (id: string) => {
    const token = choosing() ? null : typedMention();
    if (token) {
      const replaced = await editor()?.replaceRange({
        expectedText: text(),
        expectedSelection: selection(),
        start: token.start,
        end: token.end,
        text: '',
      });
      if (!replaced) return;
    }
    mention(id);
    choosing.set(false);
    query.set('');
    editor()?.focus();
  };
  effect(() => {
    const node = editor();
    if (!node || !pickerOpen()) return;
    const cleanups = [
      node.bindKey('down', () => choice.set(Math.min(choice() + 1, candidates().length - 1))),
      node.bindKey('up', () => choice.set(Math.max(0, choice() - 1))),
      node.bindKey('tab', () => {
        const item = candidates()[choice()];
        if (item) void selectMention(item.id);
      }),
    ];
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  });
  const openPicker = () => {
    choosing.set(!choosing());
    query.set('');
    if (choosing()) searchField?.focus();
  };
  return (
    <View
      style={{
        width: '100%',
        maxWidth: 960,
        alignSelf: 'center',
        gap: 8,
        paddingHorizontal: 24,
        paddingBottom: 20,
      }}
    >
      <If when={pickerOpen()}>
        <View
          style={{
            backgroundColor: C.raised,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: 14,
            padding: 8,
            gap: 4,
          }}
        >
          <If when={choosing()}>
            <Input
              ref={(node) => {
                searchField = node;
              }}
              autoFocus
              accessibilityLabel={tr('Search sessions…')}
              placeholder={tr('Search sessions…')}
              value={query()}
              onChange={({ value }) => query.set(value)}
              style={{ ...inputTextStyle, color: C.text, padding: 8 }}
            />
          </If>
          <If when={searching()}>
            <View style={{ padding: 8 }}>
              <LoadingIndicator />
            </View>
          </If>
          <Each of={candidates().slice(0, 8)} key={(session) => session.id}>
            {(session, index) => (
              <Button
                accessibilityLabel={session().title}
                onPress={() => void selectMention(session().id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  padding: 10,
                  borderRadius: 8,
                  backgroundColor: index() === choice() ? C.surface : 'transparent',
                }}
                hoverStyle={{ backgroundColor: C.surface }}
                focusStyle={controlFocusStyle()}
              >
                <Icon name="bot" color={C.secondary} />
                <Text style={{ ...bodyTextStyle, color: C.text, flex: 1 }}>{session().title}</Text>
              </Button>
            )}
          </Each>
          <If when={!searching() && candidates().length === 0}>
            <Text style={{ ...captionTextStyle, color: C.muted, padding: 8 }}>
              {tr('No matching sessions')}
            </Text>
          </If>
        </View>
      </If>
      <View style={{ backgroundColor: C.card, borderRadius: 20, padding: 16, gap: 12 }}>
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
              {(props.message(replyTo()!) ?? replyQuote())?.content.text ||
                tr('View replied message')}
            </Text>
            <Button
              accessibilityLabel={tr('Cancel reply')}
              disabled={busy() || pending() !== null}
              onPress={() => {
                replyTo.set(null);
                changed();
              }}
              style={controlStyle}
              hoverStyle={{ backgroundColor: C.surface }}
            >
              <Icon name="close" color={C.muted} />
            </Button>
          </View>
        </If>
        <If when={mentions().length > 0}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Each of={mentions()} key={(id) => id}>
              {(id) => (
                <Button
                  accessibilityLabel={tr('Remove mention {name}', { name: props.name(id()) })}
                  onPress={() => {
                    mentions.set(mentions().filter((value) => value !== id()));
                    changed();
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    borderRadius: 8,
                    backgroundColor: C.surface,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                  }}
                  hoverStyle={{ backgroundColor: C.raised }}
                >
                  <Text style={{ ...captionTextStyle, color: C.accent }}>@{props.name(id())}</Text>
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
          onSubmit={() => {
            const candidate = pickerOpen() ? candidates()[choice()] : undefined;
            if (candidate) void selectMention(candidate.id);
            else void send();
          }}
          onEscape={() => choosing.set(false)}
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
            <Text style={{ ...bodyTextStyle, color: choosing() ? C.accent : C.secondary }}>@</Text>
          </Button>
          <View style={{ flex: 1 }} />
          <Button
            accessibilityLabel={tr('Send message')}
            onPress={() => void send()}
            disabled={
              !ready() ||
              busy() ||
              pending() !== null ||
              (!text().trim() && !attachments.ids().length)
            }
            style={{
              width: 34,
              height: 34,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 17,
              backgroundColor: text().trim() || attachments.ids().length ? C.accent : C.surface,
            }}
            focusStyle={controlFocusStyle()}
          >
            <If
              when={busy()}
              else={
                <Icon
                  name="send"
                  color={text().trim() || attachments.ids().length ? C.background : C.muted}
                />
              }
            >
              <LoadingIndicator color={C.background} />
            </If>
          </Button>
        </View>
      </View>
      <If when={pending()}>
        <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 12, gap: 4 }}>
          <Text style={[{ ...captionTextStyle, color: C.secondary }, { numberOfLines: 3 }]}>
            {pending()!.correlation.draft.text}
          </Text>
          <If when={(pending()!.correlation.draft.mentions?.length ?? 0) > 0}>
            <Text style={{ ...captionTextStyle, color: C.accent }}>
              {pending()!
                .correlation.draft.mentions!.map((id) => `@${props.name(id)}`)
                .join(' ')}
            </Text>
          </If>
        </View>
      </If>
      <If when={error() || pending()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ ...captionTextStyle, color: C.warning, flex: 1 }}>
            {error() || tr('Could not send to the room.')}
          </Text>
          <Button
            accessibilityLabel={tr('Retry')}
            onPress={() =>
              void (pending()
                ? recover()
                : (ready() ? flush() : restore())
                    .then(() => error.set(''))
                    .catch((reason) => error.set(describe(reason))))
            }
            disabled={busy()}
            style={controlStyle}
          >
            <Text style={{ color: C.accent }}>{tr('Retry')}</Text>
          </Button>
          <If when={pending()}>
            <Button
              accessibilityLabel={tr('Dismiss message status')}
              onPress={() => void removePending()}
              disabled={busy()}
              style={controlStyle}
            >
              <Icon name="close" color={C.muted} />
            </Button>
          </If>
        </View>
      </If>
    </View>
  );
}

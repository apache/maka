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
  Clipboard,
  cleanup,
  createAnimatedValue,
  effect,
  platform,
  reduceMotion,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type JSX,
  type ScrollRef,
} from 'nsh';
import { Button, ContextMenu, Input, Menu, MenuItem } from 'nsh/base';
import type {
  AgentSession,
  AgentRoomMessage,
  AgentRoomHistoryPage,
  AgentWorkspaceSelection,
  AgentCreated,
  AgentSessionChanged,
  HistoryPosition,
} from '../../../../packages/plugin-sdk/src/index.js';
import { createBrowsing } from './browsing';
import { HostProvider, type Host, type Output } from './host';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  Header,
  SidebarToggle,
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlFocusStyle,
  floatingStyle,
  menuRowHoverStyle,
  menuRowStyle,
  inputTextStyle,
  type BrowserHeader,
} from './ui';
import { TITLE_BAR_HEIGHT, ownTitleBar, windowDrag } from './chrome';
import { WorkspacePicker } from './WorkspacePicker';
import { ModalDialog, DialogHeader, DialogFooter } from './ModalDialog';
import { LoadingIndicator } from './Loading';
import { MarkdownBody } from './MarkdownBody';
import { HistoryAttachments } from './Attachments';
import { ImageViewer } from './ImageViewer';
import type { ImagePreview } from './ImageThumbnail';
import { RoomComposer, type RoomComposerHandle } from './RoomComposer';
import { roomAuthorSession, roomResult } from './roomMessage';
import { currentLocale } from './locale';

const reasonText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function createRoomWorkspace(options: {
  host: Host;
  initial: string | null;
  agentSession(): string | null;
  visible(): boolean;
  browser(): BrowserHeader;
  openAgent(id: string): void;
  openSettings(): void;
  openLink(sessionId: string, target: string, restoreFocus: () => boolean): Promise<void>;
}) {
  const host = options.host;
  const browser = createBrowsing(host, 'room');
  const selected = signal(options.initial);
  const known = signal(new Map<string, AgentSession>());
  const error = signal('');
  const creating = signal(false);
  const createTitle = signal('');
  const choosingWorkspace = signal(false);
  const createBusy = signal(false);
  const renaming = signal<AgentSession | null>(null);
  const renameTitle = signal('');
  const removing = signal<AgentSession | null>(null);
  let composer: RoomComposerHandle | null = null;
  let alive = true;
  let navigation = 0;
  const remember = (sessions: AgentSession[]) =>
    known.set(new Map([...known(), ...sessions.map((session) => [session.id, session] as const)]));
  effect(() => {
    const sessions = browser.sessions();
    untracked(() => remember(sessions));
  });
  cleanup(() => {
    alive = false;
    navigation++;
  });
  const name = (id: string) => known().get(id)?.title ?? id;
  const title = () => (selected() ? known().get(selected()!)?.title : undefined) ?? tr('Rooms');
  const resolveNames = async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((id) => !known().has(id));
    const sessions = await Promise.all(
      missing.map(
        async (sessionId) => (await host.query('agent', 'observe', { sessionId })).session,
      ),
    );
    if (alive && sessions.length) remember(sessions);
  };
  const open = async (id: string | null) => {
    const generation = ++navigation;
    try {
      await composer?.flush();
      if (id !== null && !known().has(id)) await resolveNames([id]);
      if (!alive || generation !== navigation) return false;
      selected.set(id);
      error.set('');
      return true;
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
      return false;
    }
  };
  const create = async (workspace: AgentWorkspaceSelection) => {
    if (createBusy() || !createTitle().trim()) return;
    createBusy.set(true);
    error.set('');
    try {
      const observed = await host.control('create', {
        kind: 'room',
        title: createTitle().trim(),
        labels: [],
        workspace,
      });
      const result = roomResult<AgentCreated>(observed.reply);
      if (result.kind !== 'created') throw new Error(result.kind);
      remember([result.session]);
      if (await open(result.session.id))
        batch(() => {
          creating.set(false);
          choosingWorkspace.set(false);
        });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) createBusy.set(false);
    }
  };
  const createInWorkspace = async () => {
    const id = options.agentSession();
    if (id) await create({ kind: 'session', sessionId: id });
    else choosingWorkspace.set(true);
  };
  const rename = async () => {
    const session = renaming();
    if (!session || createBusy() || !renameTitle().trim()) return;
    createBusy.set(true);
    error.set('');
    try {
      const result = roomResult<{ kind: string; session?: AgentSession; reason?: string }>(
        (
          await host.control('metadata', {
            sessionId: session.id,
            expectedRevision: session.revision,
            title: renameTitle().trim(),
            labels: session.labels,
          })
        ).reply,
      );
      if (!result.session) throw new Error(result.reason ?? result.kind);
      remember([result.session]);
      renaming.set(null);
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) createBusy.set(false);
    }
  };
  const newRoom = () => {
    createTitle.set('');
    creating.set(true);
    error.set('');
  };
  const remove = async () => {
    const session = removing();
    if (!session || createBusy()) return;
    createBusy.set(true);
    error.set('');
    try {
      if (selected() === session.id) await composer?.flush();
      const result = roomResult<AgentSessionChanged>(
        (
          await host.control('changeSession', {
            sessionId: session.id,
            expectedRevision: session.revision,
            action: 'remove',
          })
        ).reply,
      );
      if (result.kind !== 'removed')
        throw new Error(result.kind === 'rejected' ? result.reason : result.kind);
      if (selected() === session.id) selected.set(null);
      const sessions = new Map(known());
      sessions.delete(session.id);
      known.set(sessions);
      removing.set(null);
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) createBusy.set(false);
    }
  };
  const roomActions = (session: AgentSession) => (
    <>
      <RoomMenuItem
        label={tr('Rename room')}
        select={() => {
          error.set('');
          renameTitle.set(session.title);
          renaming.set(session);
        }}
      />
      <RoomMenuItem
        label={tr('Delete room')}
        danger
        select={() => {
          error.set('');
          removing.set(session);
        }}
      />
    </>
  );
  const searchSessions = async (query: string) => {
    const page = await host.query('agent', 'list', {
      kind: 'agent',
      filter: 'all',
      scope: { kind: 'all' },
      position: { kind: 'start' },
      titleQuery: query,
    });
    if (alive) remember(page.sessions);
    return page.sessions;
  };
  const navigationView = (modeSwitch: JSX.Element) => (
    <HostProvider value={host}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          backgroundColor: C.chrome,
          padding: 12,
          paddingTop: ownTitleBar ? 0 : 12,
          gap: 8,
        }}
      >
        <If when={ownTitleBar && platform.idiom !== 'terminal'}>
          <View
            desktop={windowDrag}
            style={{
              height: TITLE_BAR_HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-end',
            }}
          >
            <SidebarToggle expanded toggle={options.browser().toggle} />
          </View>
        </If>
        <Button
          accessibilityLabel={tr('New room')}
          onPress={newRoom}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            padding: 10,
            borderRadius: 10,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="plus" color={C.secondary} />
          <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('New room')}</Text>
        </Button>
        {modeSwitch}
        <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ gap: 4, paddingTop: 12 }}>
          <Each of={browser.sessions()} key={(session) => session.id}>
            {(session) => (
              <ContextMenu
                offset={4}
                margin={8}
                popupStyle={floatingStyle()}
                trigger={
                  <Button
                    accessibilityLabel={session().title}
                    selected={selected() === session().id}
                    onPress={() => void open(session().id)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      padding: 12,
                      borderRadius: 10,
                      backgroundColor: selected() === session().id ? C.surface : 'transparent',
                    }}
                    hoverStyle={{ backgroundColor: C.surface }}
                    focusStyle={controlFocusStyle()}
                  >
                    <Icon name="symbol" color={C.muted} />
                    <Text
                      style={[{ ...bodyTextStyle, color: C.text, flex: 1 }, { numberOfLines: 1 }]}
                    >
                      {session().title}
                    </Text>
                    <If when={session().hasUnread && selected() !== session().id}>
                      <View
                        style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent }}
                      />
                    </If>
                  </Button>
                }
              >
                {roomActions(session())}
              </ContextMenu>
            )}
          </Each>
          <If when={browser.loading()}>
            <View style={{ padding: 12 }}>
              <LoadingIndicator />
            </View>
          </If>
          <If when={browser.hasMore()}>
            <Button
              accessibilityLabel={tr('Show more')}
              onPress={() => void browser.loadMore()}
              style={controlStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Show more')}</Text>
            </Button>
          </If>
          <If when={browser.error()}>
            <Text style={{ ...captionTextStyle, color: C.warning }}>{browser.error()}</Text>
          </If>
        </Scroll>
        <Button
          accessibilityLabel={tr('Settings')}
          onPress={options.openSettings}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            padding: 10,
            borderRadius: 10,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="settings" color={C.secondary} />
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Settings')}</Text>
        </Button>
      </View>
    </HostProvider>
  );
  const content = () => (
    <HostProvider value={host}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <Header
          title={title()}
          browser={options.browser()}
          commands={() => {}}
          actions={
            selected() && known().has(selected()!) ? (
              <Menu
                align="end"
                offset={4}
                margin={8}
                popupStyle={floatingStyle()}
                trigger={
                  <Button
                    accessibilityLabel={tr('Room actions')}
                    style={controlStyle}
                    hoverStyle={{ backgroundColor: C.surface }}
                    focusStyle={controlFocusStyle()}
                  >
                    <Icon name="more" color={C.muted} />
                  </Button>
                }
              >
                {roomActions(known().get(selected()!)!)}
              </Menu>
            ) : undefined
          }
        />
        <If when={selected() === null}>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <Icon name="symbol" size={32} color={C.muted} />
            <Button
              accessibilityLabel={tr('New room')}
              onPress={newRoom}
              style={{ ...controlStyle, paddingHorizontal: 16, backgroundColor: C.surface }}
              hoverStyle={{ backgroundColor: C.raised }}
            >
              <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('New room')}</Text>
            </Button>
          </View>
        </If>
        <Each of={selected() ? [selected()!] : []} key={(id) => id}>
          {(id) => (
            <RoomTimeline
              sessionId={id()}
              host={host}
              visible={options.visible}
              name={name}
              resolveNames={resolveNames}
              searchSessions={searchSessions}
              openAgent={options.openAgent}
              openLink={(target, restoreFocus) => options.openLink(id(), target, restoreFocus)}
              attach={(handle) => {
                composer = handle;
              }}
            />
          )}
        </Each>
        <If when={error()}>
          <Text style={{ ...captionTextStyle, color: C.warning, padding: 12 }}>{error()}</Text>
        </If>
      </View>
      <If when={creating() && !choosingWorkspace()}>
        <ModalDialog
          size="form"
          onCancel={() => {
            if (!createBusy()) creating.set(false);
          }}
        >
          <DialogHeader title={tr('New room')} />
          <Input
            accessibilityLabel={tr('Room name')}
            placeholder={tr('Room name')}
            autoFocus
            value={createTitle()}
            onChange={({ value }) => createTitle.set(value)}
            onSubmit={() => void createInWorkspace()}
            style={{
              ...inputTextStyle,
              color: C.text,
              backgroundColor: C.raised,
              borderRadius: 8,
              padding: 10,
            }}
          />
          <If when={error()}>
            <Text style={{ color: C.warning }}>{error()}</Text>
          </If>
          <DialogFooter>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={() => creating.set(false)}
              disabled={createBusy()}
              style={controlStyle}
            >
              <Text style={{ color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('New room')}
              onPress={() => void createInWorkspace()}
              disabled={createBusy() || !createTitle().trim()}
              style={controlStyle}
            >
              <Text style={{ color: C.accent }}>{tr('New room')}</Text>
            </Button>
          </DialogFooter>
        </ModalDialog>
      </If>
      <If when={creating() && choosingWorkspace()}>
        <WorkspacePicker
          instance={1}
          current={() => creating() && choosingWorkspace()}
          close={() => {
            choosingWorkspace.set(false);
            return true;
          }}
          create={create}
          changed={() => {}}
        />
      </If>
      <If when={renaming()}>
        <ModalDialog
          size="form"
          onCancel={() => {
            if (!createBusy()) renaming.set(null);
          }}
        >
          <DialogHeader title={tr('Rename room')} />
          <Input
            accessibilityLabel={tr('Room name')}
            value={renameTitle()}
            autoFocus
            onChange={({ value }) => renameTitle.set(value)}
            onSubmit={() => void rename()}
            style={{
              ...inputTextStyle,
              color: C.text,
              backgroundColor: C.raised,
              borderRadius: 8,
              padding: 10,
            }}
          />
          <If when={error()}>
            <Text style={{ color: C.warning }}>{error()}</Text>
          </If>
          <DialogFooter>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={() => renaming.set(null)}
              disabled={createBusy()}
              style={controlStyle}
            >
              <Text style={{ color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Save')}
              onPress={() => void rename()}
              disabled={createBusy() || !renameTitle().trim()}
              style={controlStyle}
            >
              <Text style={{ color: C.accent }}>{tr('Save')}</Text>
            </Button>
          </DialogFooter>
        </ModalDialog>
      </If>
      <If when={removing()}>
        <ModalDialog
          size="form"
          onCancel={() => {
            if (!createBusy()) removing.set(null);
          }}
        >
          <DialogHeader title={tr('Delete room')} />
          <Text style={{ ...bodyTextStyle, color: C.text }}>
            {tr('Delete “{title}” and its messages?', { title: removing()!.title })}
          </Text>
          <If when={error()}>
            <Text style={{ color: C.warning }}>{error()}</Text>
          </If>
          <DialogFooter>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={() => removing.set(null)}
              disabled={createBusy()}
              style={controlStyle}
            >
              <Text style={{ color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Confirm delete room')}
              onPress={() => void remove()}
              disabled={createBusy()}
              style={controlStyle}
            >
              <Text style={{ color: C.danger }}>{tr('Delete')}</Text>
            </Button>
          </DialogFooter>
        </ModalDialog>
      </If>
    </HostProvider>
  );
  if (options.initial)
    void resolveNames([options.initial]).catch((reason) => error.set(reasonText(reason)));
  return {
    selected,
    title,
    open,
    navigation: navigationView,
    content,
    flush: () => composer?.flush() ?? Promise.resolve(),
    directory: () => (selected() ? known().get(selected()!)?.workspace.path : undefined),
    report: (reason: unknown) => error.set(reasonText(reason)),
  };
}

function RoomTimeline(props: {
  sessionId: string;
  host: Host;
  visible(): boolean;
  name(id: string): string;
  resolveNames(ids: string[]): Promise<void>;
  searchSessions(query: string): Promise<AgentSession[]>;
  openAgent(id: string): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  attach(handle: RoomComposerHandle | null): void;
}) {
  const messages = signal<AgentRoomMessage[]>([]);
  const before = signal<string | null>(null);
  const after = signal<string | null>(null);
  const ready = signal(false);
  const error = signal('');
  const loadingEarlier = signal(false);
  const atEnd = signal(true);
  const viewer = signal<ImagePreview | null>(null);
  const rise = createAnimatedValue(reduceMotion() ? 0 : 8);
  if (!reduceMotion()) void rise.spring(0, { stiffness: 320, damping: 30 });
  let through = 0;
  let alive = true;
  let scroll: ScrollRef | null = null;
  let stream: { next(): Promise<Output<'agent', 'watch'> | null>; close(): Promise<void> } | null =
    null;
  let composer: RoomComposerHandle | null = null;
  let contentHeight = 0;
  let scrollY = 0;
  let prependAnchor: { height: number; y: number } | null = null;
  let lastMarked: string | null = null;
  let reading: Promise<void> | null = null;
  const map = () => new Map(messages().map((message) => [message.id, message]));
  const read = async (position: HistoryPosition): Promise<AgentRoomHistoryPage> => {
    const result = await props.host.query('agent', 'history', {
      sessionId: props.sessionId,
      position,
    });
    if (result.kind !== 'room') throw new Error('Expected Room history.');
    return result.page;
  };
  const publish = (page: AgentRoomHistoryPage, mode: 'replace' | 'append' | 'prepend') => {
    if (!alive) return;
    const merged = mode === 'replace' ? page.items : [...messages(), ...page.items];
    batch(() => {
      messages.set(
        [...new Map(merged.map((message) => [message.id, message])).values()].sort(
          (a, b) => a.sequence - b.sequence,
        ),
      );
      if (mode !== 'append') before.set(page.before ?? null);
      if (mode !== 'prepend') after.set(page.after ?? null);
      through = Math.max(through, page.through);
      ready.set(true);
    });
    const ids = page.items.flatMap((message) => [
      ...message.mentions,
      ...(roomAuthorSession(message) ? [roomAuthorSession(message)!] : []),
    ]);
    void props.resolveNames(ids).catch((reason) => {
      if (alive) error.set(reasonText(reason));
    });
  };
  const refresh = (): Promise<void> => {
    if (reading) return reading;
    reading = (async () => {
      const last = messages().at(-1)?.id;
      if (after() !== null) return;
      if (!last) {
        publish(await read({ kind: 'tail' }), 'replace');
        return;
      }
      let cursor = last;
      do {
        const page = await read({ kind: 'after_message', messageId: cursor });
        publish(page, 'append');
        if (!page.after || !alive) break;
        cursor = page.after;
      } while (alive);
    })().finally(() => {
      reading = null;
    });
    return reading;
  };
  const latest = async () => {
    try {
      atEnd.set(true);
      publish(await read({ kind: 'tail' }), 'replace');
      scroll?.scrollToEnd({ animated: !reduceMotion() });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    }
  };
  const earlier = async () => {
    const cursor = before();
    if (!cursor || loadingEarlier()) return;
    loadingEarlier.set(true);
    try {
      const page = await read({ kind: 'before_message', messageId: cursor });
      prependAnchor = { height: contentHeight, y: scrollY };
      atEnd.set(false);
      publish(page, 'prepend');
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) loadingEarlier.set(false);
    }
  };
  const focusMessage = async (messageId: string) => {
    try {
      atEnd.set(false);
      publish(await read({ kind: 'message', messageId }), 'replace');
      scroll?.scrollTo({ y: 0, animated: !reduceMotion() });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    }
  };
  const start = async () => {
    if (stream) return;
    error.set('');
    try {
      const page = await read({ kind: 'tail' });
      publish(page, 'replace');
      const opened = await props.host.subscribe('agent', 'watch', {
        sessionId: props.sessionId,
        after: page.through,
      });
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      for (;;) {
        const update = await opened.next();
        if (!alive) break;
        if (update === null) throw new Error(tr('Live updates ended.'));
        if (update.kind === 'room' && update.through > through) await refresh();
      }
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      const current = stream;
      stream = null;
      if (current) await current.close();
    }
  };
  void start();
  cleanup(() => {
    alive = false;
    const current = stream;
    stream = null;
    if (current)
      void current.close().catch((reason) => console.warn('Room observer cleanup failed:', reason));
  });
  effect(() => {
    const tail = messages().at(-1)?.id;
    if (!props.visible() || !atEnd() || after() !== null || !tail || lastMarked === tail) return;
    lastMarked = tail;
    void props.host
      .control('markRead', { sessionId: props.sessionId, messageId: tail })
      .then(({ reply }) => roomResult(reply))
      .catch((reason) => {
        if (alive) {
          lastMarked = null;
          error.set(reasonText(reason));
        }
      });
  });
  const author = (message: AgentRoomMessage) => {
    const id = roomAuthorSession(message);
    return id ? props.name(id) : tr('You');
  };
  const time = (at: number) =>
    new Date(at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' });
  return (
    <View style={{ flex: 1, minHeight: 0, transform: [{ translateY: rise }] }}>
      <Scroll
        accessibilityLabel={tr('Room messages')}
        ref={(node) => {
          scroll = node;
        }}
        style={{ flex: 1, minHeight: 0 }}
        onScroll={(event) => {
          scrollY = event.offset.y;
          atEnd.set(event.offset.y >= event.contentSize.height - event.size.height - 48);
        }}
        contentStyle={{ paddingHorizontal: 24, paddingVertical: 24 }}
      >
        <View
          style={{ width: '100%', maxWidth: 912, alignSelf: 'center', gap: 24 }}
          onLayout={({ bounds }) => {
            if (prependAnchor) {
              scroll?.scrollTo({
                y: prependAnchor.y + bounds.size.height - prependAnchor.height,
                animated: false,
              });
              prependAnchor = null;
            } else if (atEnd()) scroll?.scrollToEnd({ animated: false });
            contentHeight = bounds.size.height;
          }}
        >
          <If when={before()}>
            <Button
              accessibilityLabel={tr('Earlier messages')}
              disabled={loadingEarlier()}
              onPress={() => void earlier()}
              style={{ ...controlStyle, alignSelf: 'center' }}
              hoverStyle={{ backgroundColor: C.surface }}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('Earlier messages')}
              </Text>
            </Button>
          </If>
          <If when={!ready()}>
            <View style={{ padding: 24, alignItems: 'center' }}>
              <LoadingIndicator />
            </View>
          </If>
          <Each of={messages()} key={(message) => message.id}>
            {(message) => (
              <ContextMenu
                offset={4}
                margin={8}
                popupStyle={floatingStyle()}
                trigger={
                  <View selectable class="group" style={{ flexDirection: 'row', gap: 12 }}>
                    <View
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 10,
                        backgroundColor: C.surface,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <If
                        when={message().author.kind === 'human'}
                        else={<Icon name="bot" size={16} color={C.secondary} />}
                      >
                        <Text style={{ ...captionTextStyle, color: C.secondary }}>
                          {tr('You').slice(0, 1)}
                        </Text>
                      </If>
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Button
                          accessibilityLabel={author(message())}
                          disabled={message().author.kind === 'human'}
                          onPress={() => {
                            const id = roomAuthorSession(message());
                            if (id) props.openAgent(id);
                          }}
                          style={{ paddingVertical: 4 }}
                        >
                          <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.text }}>
                            {author(message())}
                          </Text>
                        </Button>
                        <Text style={{ ...captionTextStyle, color: C.muted }}>
                          {time(message().at)}
                        </Text>
                        <View style={{ flex: 1 }} />
                        <View
                          class={
                            platform.idiom === 'terminal'
                              ? undefined
                              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                          }
                        >
                          <Button
                            accessibilityLabel={tr('Reply to message')}
                            onPress={() => composer?.reply(message())}
                            style={{ ...controlStyle, minHeight: 24, paddingVertical: 2 }}
                            hoverStyle={{ backgroundColor: C.surface }}
                            focusStyle={controlFocusStyle()}
                          >
                            <Icon name="undo" size={14} color={C.muted} />
                          </Button>
                        </View>
                      </View>
                      <If when={message().replyTo}>
                        <Button
                          accessibilityLabel={tr('View replied message')}
                          onPress={() => void focusMessage(message().replyTo!)}
                          style={{
                            borderLeftWidth: 2,
                            borderLeftColor: C.line,
                            paddingLeft: 10,
                            paddingVertical: 4,
                          }}
                          hoverStyle={{ backgroundColor: C.surface }}
                        >
                          <Text
                            style={[
                              { ...captionTextStyle, color: C.secondary },
                              { numberOfLines: 1 },
                            ]}
                          >
                            {map().get(message().replyTo!)?.content.text ||
                              tr('View replied message')}
                          </Text>
                        </Button>
                      </If>
                      <If when={message().mentions.length > 0}>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                          <Each of={message().mentions} key={(id) => id}>
                            {(id) => (
                              <Button
                                accessibilityLabel={props.name(id())}
                                onPress={() => props.openAgent(id())}
                              >
                                <Text style={{ ...captionTextStyle, color: C.accent }}>
                                  @{props.name(id())}
                                </Text>
                              </Button>
                            )}
                          </Each>
                        </View>
                      </If>
                      <If when={message().content.text}>
                        <MarkdownBody
                          selectable={false}
                          row={() => ({
                            key: message().id,
                            messageId: message().id,
                            field: 'body',
                            role: message().author.kind === 'human' ? 'user' : 'assistant',
                            text: message().content.text,
                            closedAt: message().at,
                          })}
                          sourceId={message().id}
                          sessionId={props.sessionId}
                          openLink={props.openLink}
                          userScroll={() => {}}
                        />
                      </If>
                      <If when={message().content.attachments.length > 0}>
                        <HistoryAttachments
                          sessionId={props.sessionId}
                          through={through}
                          roomMessageId={message().id}
                          attachments={message().content.attachments}
                          preview={(image) => viewer.set(image)}
                          userScroll={() => {}}
                        />
                      </If>
                      <Each
                        of={message().deliveries.filter((delivery) => delivery.kind === 'rejected')}
                        key={(delivery) => delivery.sessionId}
                      >
                        {(delivery) => (
                          <Text style={{ ...captionTextStyle, color: C.warning }}>
                            {delivery().kind === 'rejected'
                              ? tr('Mention delivery failed: {reason}', {
                                  reason: delivery().reason,
                                })
                              : ''}
                          </Text>
                        )}
                      </Each>
                    </View>
                  </View>
                }
              >
                <RoomMenuItem
                  label={tr('Reply to message')}
                  select={() => composer?.reply(message())}
                />
                <If when={message().content.text}>
                  <RoomMenuItem
                    label={tr('Copy message')}
                    select={() => {
                      void Clipboard.writeText(message().content.text).catch((reason) => {
                        if (alive) error.set(reasonText(reason));
                      });
                    }}
                  />
                </If>
              </ContextMenu>
            )}
          </Each>
        </View>
      </Scroll>
      <If when={(!atEnd() || after()) && ready()}>
        <Button
          accessibilityLabel={tr('Latest')}
          onPress={() => void latest()}
          style={{
            ...controlStyle,
            alignSelf: 'center',
            borderRadius: 14,
            paddingHorizontal: 14,
            paddingVertical: 6,
            backgroundColor: C.raised,
            marginBottom: 10,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="down" color={C.secondary} />
            <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Latest')}</Text>
          </View>
        </Button>
      </If>
      <If when={error()}>
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 24, alignItems: 'center' }}>
          <Text style={{ ...captionTextStyle, color: C.warning, flex: 1 }}>{error()}</Text>
          <Button
            accessibilityLabel={tr('Retry')}
            onPress={() => void start()}
            style={controlStyle}
          >
            <Text style={{ color: C.accent }}>{tr('Retry')}</Text>
          </Button>
        </View>
      </If>
      <RoomComposer
        sessionId={props.sessionId}
        name={props.name}
        resolveNames={props.resolveNames}
        message={(id) => map().get(id)}
        searchSessions={props.searchSessions}
        posted={refresh}
        preview={(image) => viewer.set(image)}
        attach={(handle) => {
          composer = handle;
          props.attach(handle);
        }}
      />
      <If when={viewer()}>
        <ImageViewer
          image={{ ...viewer()!, title: tr('Message attachments') }}
          close={() => {
            const original = viewer();
            viewer.set(null);
            original?.restoreFocus?.();
          }}
        />
      </If>
    </View>
  );
}

function RoomMenuItem(props: { label: string; danger?: boolean; select(): void }) {
  return (
    <MenuItem
      accessibilityLabel={props.label}
      onSelect={props.select}
      style={{ ...menuRowStyle(), minWidth: 160 }}
      hoverStyle={menuRowHoverStyle()}
      focusStyle={menuRowHoverStyle()}
    >
      <Text style={{ ...captionTextStyle, color: props.danger ? C.danger : C.text }}>
        {props.label}
      </Text>
    </MenuItem>
  );
}

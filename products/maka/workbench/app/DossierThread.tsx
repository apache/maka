/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import {
  cleanup,
  computed,
  effect,
  Scroll,
  signal,
  Text,
  View,
  type JSX,
  type ScrollRef,
} from 'nsh';
import { Button, Input } from 'nsh/base';
import { useHost } from './host';
import {
  dossierThreadActivity,
  dossierThreadMessages,
  mergeHistoryPage,
  type DossierToolStep,
} from './history';
import { observeDiscovery } from './discoveryObservation';
import {
  nextDossierScrollState,
  type DossierScrollState,
  type DossierThreadTurn,
} from './discoveryDossiersCore';
import { activityTitle } from './toolActivityPresentation';
import { Icon } from './Icon';
import { tr } from './locale';
import { motionEnabled, useLiveMessageStyle } from './roomMotion';
import { createText, errorText, UiError } from './text';
import {
  C,
  captionTextStyle,
  composerIconSlot,
  inputTextStyle,
  quietFocusStyle,
  secondaryTextStyle,
  textTooltip,
} from './ui';

export const readingColumn = {
  width: '100%',
  maxWidth: 720,
  alignSelf: 'center',
  paddingHorizontal: 28,
} as const;

export function ThreadBubble(props: {
  turn: DossierThreadTurn;
  timeLabel?: string;
  dimmed?: boolean;
  onArrival(): void;
}) {
  const entrance = useLiveMessageStyle(Boolean(props.turn.live));
  const mine = () => props.turn.role === 'user';
  return (
    <View
      onLayout={props.turn.live ? props.onArrival : undefined}
      style={[
        {
          alignSelf: mine() ? 'flex-end' : 'flex-start',
          maxWidth: '86%',
          gap: 3,
          opacity: props.dimmed ? 0.78 : 1,
        },
        motionEnabled() ? entrance : undefined,
      ]}
    >
      <View
        style={{
          paddingHorizontal: 13,
          paddingVertical: 8,
          borderRadius: 14,
          borderBottomRightRadius: mine() ? 4 : 14,
          borderBottomLeftRadius: mine() ? 14 : 4,
          backgroundColor: mine() ? C.accent + '1a' : C.surface,
          borderWidth: mine() ? 0 : 0.5,
          borderColor: C.line,
        }}
      >
        <Text style={{ ...secondaryTextStyle, color: C.text, userSelect: 'text' }}>
          {props.turn.text}
        </Text>
      </View>
      <If when={props.timeLabel}>
        <Text
          style={{
            ...captionTextStyle,
            fontSize: 11,
            color: C.muted,
            alignSelf: mine() ? 'flex-end' : 'flex-start',
            paddingHorizontal: 4,
          }}
        >
          {props.timeLabel}
        </Text>
      </If>
    </View>
  );
}

export function DossierThread(props: {
  topicId: string;
  ready: boolean;
  hasHistory(): boolean;
  threadSessionId(): string | null;
  openSession(id: string): void;
  header(actions: { scrollToLatest(): void; session(): string | null }): JSX.Element;
  renderStream(ctx: {
    turns(): readonly DossierThreadTurn[];
    sendMessage(message: string, options?: { elevate?: boolean }): Promise<boolean>;
    sending(): boolean;
    anchorLatest(y: number): void;
    onTurnArrival(): void;
    session(): string | null;
  }): JSX.Element;
}) {
  const host = useHost();
  const topicId = props.topicId;
  const draft = signal('');
  const sending = signal(false);
  const opened = signal<string | null>(null);
  const session = computed(() => props.threadSessionId() ?? opened());
  const turns = signal<DossierThreadTurn[]>([]);
  const activity = signal<{ steps: DossierToolStep[]; active: boolean }>({
    steps: [],
    active: false,
  });
  const historyError = createText();
  const sendError = createText();
  const awayFromLatest = signal(false);
  const canSend = () => props.ready && !sending() && draft().trim().length > 0;
  let lastTurnsJson = '[]';
  let lastActivityJson = '{"steps":[],"active":false}';
  let scroll: ScrollRef | undefined;
  let scrollState: DossierScrollState = {
    stickToBottom: true,
    userInteracted: false,
    lastScrollY: 0,
    lastContentHeight: 0,
  };
  let programmaticUntil = 0;
  let alive = true;
  let stopWatch: (() => void) | null = null;

  const pinToBottom = (animated = false) => {
    scrollState = { ...scrollState, stickToBottom: true };
    awayFromLatest.set(false);
    programmaticUntil = Date.now() + (animated ? 400 : 150);
    scroll?.scrollToEnd({ animated: animated && motionEnabled() });
  };

  cleanup(() => {
    alive = false;
    stopWatch?.();
    stopWatch = null;
  });

  effect(() => {
    const id = session();
    stopWatch?.();
    stopWatch = null;
    if (!id) {
      if (lastTurnsJson !== '[]') {
        lastTurnsJson = '[]';
        turns.set([]);
      }
      if (lastActivityJson !== '{"steps":[],"active":false}') {
        lastActivityJson = '{"steps":[],"active":false}';
        activity.set({ steps: [], active: false });
      }
      historyError.set('');
      return;
    }
    let active = true;
    let through = 0;
    const tail = async (live: boolean) => {
      const page = await host.query('agent', 'history', {
        sessionId: id,
        position: { kind: 'tail' },
        view: 'chat',
        includeThinking: false,
      });
      if (page.kind !== 'ready') throw new UiError('Could not load conversation history.');
      if (alive && active) {
        through = page.through ?? 0;
        const rows = mergeHistoryPage(page.chunks, () => undefined, false, page.through);
        const recent = dossierThreadMessages(rows);
        const nextTurnsJson = JSON.stringify(recent);
        if (nextTurnsJson !== lastTurnsJson) {
          lastTurnsJson = nextTurnsJson;
          const previous = new Set(turns().map((turn) => turn.id));
          turns.set(recent.map((turn) => ({ ...turn, live: live && !previous.has(turn.id) })));
        }
        const nextActivity = dossierThreadActivity(rows);
        const nextActivityJson = JSON.stringify(nextActivity);
        if (nextActivityJson !== lastActivityJson) {
          lastActivityJson = nextActivityJson;
          activity.set(nextActivity);
        }
        historyError.set('');
        if (
          recent.length > 0 &&
          ((!live && !scrollState.userInteracted) || scrollState.stickToBottom)
        ) {
          pinToBottom(false);
        }
      }
    };
    const cancel = observeDiscovery(
      async () => {
        await tail(false);
        return host.subscribe('agent', 'watch', { sessionId: id, after: through });
      },
      async (update) => {
        if (
          update.kind === 'events' &&
          update.events.some(
            ({ sequence, fact }) =>
              sequence > through &&
              (fact.kind === 'opened' ||
                fact.kind === 'part_committed' ||
                fact.kind === 'ended' ||
                fact.kind === 'executor_text_changed' ||
                fact.kind === 'transcript_changed'),
          )
        )
          await tail(true);
      },
      (reason) => {
        if (alive && active)
          historyError.set(errorText(reason, 'Could not load conversation history.'));
      },
    );
    stopWatch = () => {
      active = false;
      cancel();
    };
  });

  const scrollToLatest = (animated = true) => {
    scrollState = { ...scrollState, userInteracted: false };
    pinToBottom(animated);
  };

  const anchorLatest = (_y: number) => {
    if (scrollState.stickToBottom && !scrollState.userInteracted && !sending()) {
      pinToBottom(false);
    }
  };

  const sendMessage = async (raw: string, options?: { elevate?: boolean }): Promise<boolean> => {
    const message = raw.trim();
    if (!alive || !props.ready || sending() || message.length === 0) return false;
    sending.set(true);
    sendError.set('');
    scrollState = { ...scrollState, userInteracted: false };
    pinToBottom(false);
    try {
      let sessionId = session();
      if (sessionId === null || options?.elevate) {
        const thread = await host.mutateAgent('openDossierThread', {
          topicId,
          ...(options?.elevate ? { elevate: true } : {}),
        });
        sessionId = thread.sessionId;
        if (alive) opened.set(sessionId);
      }
      const result = await host.mutateAgent('send', { sessionId, message, delivery: 'steer' });
      if (result.kind === 'rejected') {
        const reasons = {
          model_unavailable: 'Selected model is unavailable',
          workspace_unavailable: 'Workspace is unavailable',
          skills_unavailable: 'Requested skills are unavailable',
          turn_stopped: 'The turn was stopped before delivery',
          original_operation_unsettled: 'The original send is still being resolved',
        } as const;
        throw new UiError(reasons[result.reason]);
      }
      if (result.sessionId !== sessionId || (result.kind !== 'started' && result.kind !== 'queued'))
        throw new UiError('Host returned an unexpected send result.');
      if (alive) {
        pinToBottom(false);
      }
      return true;
    } catch (reason) {
      if (alive) sendError.set(errorText(reason, 'Could not send the message.'));
      return false;
    } finally {
      if (alive) sending.set(false);
    }
  };

  const submitDraft = async () => {
    const text = draft();
    if (!canSend()) return;
    const ok = await sendMessage(text);
    if (ok && alive) draft.set('');
  };

  return (
    <>
      {props.header({ scrollToLatest: () => scrollToLatest(true), session })}
      <View style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
        <Scroll
          ref={(node) => {
            scroll = node;
            if (node && scrollState.stickToBottom && !scrollState.userInteracted) {
              pinToBottom(false);
            }
          }}
          style={{ flex: 1, minWidth: 0, minHeight: 0 }}
          onScroll={({ offset, contentSize, size }) => {
            const next = nextDossierScrollState(scrollState, {
              offsetY: offset.y,
              contentHeight: contentSize.height,
              viewportHeight: size.height,
              inProgrammaticWindow: Date.now() <= programmaticUntil,
            });
            scrollState = {
              stickToBottom: next.stickToBottom,
              userInteracted: next.userInteracted,
              lastScrollY: next.lastScrollY,
              lastContentHeight: next.lastContentHeight,
            };
            if (next.awayFromLatest !== null) awayFromLatest.set(next.awayFromLatest);
            if (next.action === 'pin') pinToBottom(false);
          }}
        >
          <View
            onLayout={() => {
              if (scrollState.stickToBottom) pinToBottom(false);
            }}
            style={{ ...readingColumn, paddingVertical: 18, gap: 14 }}
          >
            {props.renderStream({
              turns,
              sendMessage,
              sending,
              anchorLatest,
              onTurnArrival: () => {
                if (scrollState.stickToBottom) pinToBottom(false);
              },
              session,
            })}
            <If when={activity().active}>
              <View
                style={{
                  alignSelf: 'flex-start',
                  maxWidth: '86%',
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 12,
                  backgroundColor: C.surface,
                  borderWidth: 0.5,
                  borderColor: C.line,
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: C.accent,
                    }}
                  />
                  <Text style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}>
                    {tr('Dossier executing')}
                  </Text>
                </View>
                <Each of={activity().steps} key={(step) => step.id}>
                  {(step: () => DossierToolStep) => (
                    <Text
                      style={{
                        ...captionTextStyle,
                        fontSize: 11,
                        numberOfLines: 1,
                        color: step().failed ? C.danger : C.muted,
                      }}
                    >
                      {`${step().pending ? '⋯' : step().failed ? '✕' : '✓'} ${activityTitle({
                        name: step().name,
                        title: step().title,
                        presentation: step().presentation,
                      })}`}
                    </Text>
                  )}
                </Each>
              </View>
            </If>
            <If when={historyError()}>
              <Text style={{ ...captionTextStyle, color: C.danger }}>{historyError()}</Text>
            </If>
          </View>
        </Scroll>
        <If when={awayFromLatest()}>
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 12,
              alignItems: 'flex-end',
              paddingHorizontal: 20,
              pointerEvents: 'box-none',
            }}
          >
            <Button
              accessibilityLabel={tr('Dossier back to latest')}
              onPress={() => scrollToLatest(true)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                paddingHorizontal: 11,
                paddingVertical: 6,
                borderRadius: 16,
                backgroundColor: C.raised,
                borderWidth: 1,
                borderColor: C.line,
              }}
              hoverStyle={{ backgroundColor: C.surface }}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="latest" size={12} color={C.text} />
              <Text style={{ ...captionTextStyle, fontSize: 12, color: C.text, fontWeight: '500' }}>
                {tr('Dossier back to latest')}
              </Text>
            </Button>
          </View>
        </If>
      </View>
      <View style={{ ...readingColumn, paddingVertical: 12, flexShrink: 0, gap: 6 }}>
        <If when={sendError()}>
          <Text style={{ ...captionTextStyle, color: C.danger }}>{sendError()}</Text>
        </If>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
            backgroundColor: C.surface,
            borderWidth: 0.5,
            borderColor: C.line,
            borderRadius: 14,
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}
        >
          <Input
            accessibilityLabel={tr('Reply to this dossier')}
            placeholder={tr('Reply to this dossier')}
            value={draft()}
            onChange={({ value }) => draft.set(value)}
            readonly={sending()}
            onSubmit={() => void submitDraft()}
            submitBehavior="submit"
            style={{
              ...inputTextStyle,
              flex: 1,
              minWidth: 0,
              height: 32,
              color: C.text,
              placeholderColor: C.muted,
              backgroundColor: 'transparent',
            }}
            focusStyle={quietFocusStyle()}
          />
          <Button
            accessibilityLabel={tr('Send')}
            tooltip={textTooltip(() => tr('Send'))}
            onPress={() => void submitDraft()}
            disabled={!canSend()}
            style={{ ...composerIconSlot, borderRadius: 16, backgroundColor: C.accent }}
            hoverStyle={{ backgroundColor: C.accentHover }}
            activeStyle={motionEnabled() ? { transform: [{ scale: 0.92 }] } : undefined}
            focusStyle={{ backgroundColor: C.accentHover }}
            disabledStyle={{ backgroundColor: C.line }}
          >
            <Icon name="send" color={canSend() ? C.background : C.muted} />
          </Button>
        </View>
      </View>
    </>
  );
}

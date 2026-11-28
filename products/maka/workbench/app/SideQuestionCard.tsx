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
  cleanup,
  createAnimatedValue,
  keymap,
  signal,
  Text,
  View,
  type InputRef,
  type JSX,
} from 'nsh';
import { Button, Input } from 'nsh/base';
import type { AgentSession, QuoteRef } from '../../../../packages/plugin-sdk/src/index.js';
import {
  hasComposerContent,
  type ComposerSession,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import { DraftQuotes } from '../../../../plugins/agent/composer/ui/DraftQuotes';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { tr } from './locale';
import { RoomReactionBurst } from './RoomReactions';
import { sessionStatusCaption } from './sessionStatus';
import { motionEnabled, ROOM_SPRING } from './roomMotion';
import { sideFollowUps, type SideFollowUp } from './sideQuestions';
import { errorText, renderText } from './text';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  controlDisabledStyle,
  IconButton,
  lineWidth,
  quietFocusStyle,
  radius,
  textTooltip,
} from './ui';

const INSET = 16;
const MAX_INPUT_HEIGHT = 120;

/**
 * The card a side question stands in: one step above the panel it is beside.
 * It arrives from the side it stays on.
 */
export function SideCardFrame(props: { children: JSX.Element }) {
  const shown = createAnimatedValue(motionEnabled() ? 0 : 1);
  if (motionEnabled()) void shown.spring(1, { stiffness: 320, damping: 30 });
  cleanup(() => shown.stop());
  return (
    <View
      style={{
        flexShrink: 1,
        minHeight: 0,
        borderRadius: radius(14),
        borderWidth: lineWidth(),
        borderColor: C.line,
        // Beside the conversation, in the tone of what stands beside it (the
        // sidebar's); what is said inside steps back up to the panel's.
        backgroundColor: C.chrome,
        overflow: 'hidden',
        opacity: shown,
        transform: [
          { translateX: shown.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
        ],
      }}
    >
      {props.children}
    </View>
  );
}

/** What a side question asks about: the passages, set apart by a rule. */
export function SideQuotes(props: { quotes: readonly QuoteRef[] }) {
  return (
    <View style={{ gap: 8 }}>
      <Each of={props.quotes} key={(_, index) => index}>
        {(quote) => (
          <View style={{ borderLeftWidth: 2, borderColor: C.accent, paddingLeft: 10 }}>
            <Text
              style={[
                { ...captionTextStyle, lineHeight: 20, color: C.secondary },
                { numberOfLines: 3, textOverflow: 'ellipsis', userSelect: 'text' },
              ]}
            >
              {quote().text}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/** The passages gathered to ask about together, above the composer. */
export function SideQuoteTray(props: {
  quotes(): readonly string[];
  ask(): void;
  remove(index: number): void;
  clear(): void;
}) {
  const shown = createAnimatedValue(motionEnabled() ? 0 : 1);
  if (motionEnabled()) void shown.spring(1, { stiffness: 320, damping: 30 });
  cleanup(() => shown.stop());
  return (
    <View
      style={{
        marginTop: 8,
        paddingVertical: 4,
        paddingLeft: 12,
        paddingRight: 4,
        borderWidth: lineWidth(),
        borderColor: C.line,
        borderRadius: radius(14),
        backgroundColor: C.chrome,
        opacity: shown,
        transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 32 }}>
        <Icon name="ask" color={C.muted} size={14} />
        <Text style={{ ...captionTextStyle, color: C.secondary, fontWeight: '600', flex: 1 }}>
          {tr('{count} passages quoted', { count: props.quotes().length })}
        </Text>
        <TrayButton label={tr('Clear quotes')} color={C.muted} onPress={props.clear} />
        <TrayButton label={tr('Ask about them beside')} color={C.accentText} onPress={props.ask} />
      </View>
      <Each
        of={props.quotes().map((text, index) => ({ text, index }))}
        key={(quote) => `${quote.index}:${quote.text}`}
      >
        {(quote) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ flex: 1, minWidth: 0, borderLeftWidth: 2, borderColor: C.accent }}>
              <Text
                style={[
                  { ...captionTextStyle, color: C.secondary, paddingLeft: 10 },
                  { numberOfLines: 1, textOverflow: 'ellipsis' },
                ]}
              >
                {quote().text.replace(/\s+/g, ' ')}
              </Text>
            </View>
            <IconButton
              label={tr('Remove quote')}
              icon="close"
              onPress={() => props.remove(quote().index)}
            />
          </View>
        )}
      </Each>
    </View>
  );
}

function TrayButton(props: { label: string; color: string; onPress(): void }) {
  return (
    <Button
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={{
        height: 28,
        paddingHorizontal: 8,
        borderRadius: radius(8),
        justifyContent: 'center',
      }}
      hoverStyle={{ backgroundColor: C.card }}
      focusStyle={quietFocusStyle()}
    >
      <Text style={{ ...captionTextStyle, color: props.color, fontWeight: '600' }}>
        {props.label}
      </Text>
    </Button>
  );
}

function sideInputStyle() {
  return {
    ...bodyTextStyle,
    padding: 0,
    color: C.text,
    placeholderColor: C.muted,
    backgroundColor: 'transparent',
  } as const;
}

function InputRow(props: {
  attach?(node: InputRef): void;
  label: string;
  placeholder: string;
  value: string;
  readonly: boolean;
  change(value: string): void;
  submit(): void;
  action: JSX.Element;
}) {
  const height = signal<number>(bodyTextStyle.lineHeight);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
        paddingLeft: INSET,
        paddingRight: 8,
        paddingVertical: 8,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 4 }}>
        <Input
          ref={props.attach}
          autoFocus
          multiline
          submitBehavior="submit"
          accessibilityLabel={props.label}
          placeholder={props.placeholder}
          value={props.value}
          readonly={props.readonly}
          onChange={({ value }) => props.change(value)}
          onSubmit={props.submit}
          onContentSizeChange={({ size }) => height.set(Math.min(size.height, MAX_INPUT_HEIGHT))}
          style={{ ...sideInputStyle(), height: height() }}
        />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>{props.action}</View>
    </View>
  );
}

/**
 * A side question before it is asked: what it is about, and where to ask.
 * Its conversation is created when the question is sent.
 */
export function SideAskCard(props: {
  quotes: readonly QuoteRef[];
  ask(question: string): Promise<void>;
  close(): void;
}) {
  const text = signal('');
  const asking = signal(false);
  const failure = signal('');
  let unbind: (() => void) | undefined;
  cleanup(() => unbind?.());
  const ask = () => {
    const question = text().trim();
    if (asking() || question === '') return;
    asking.set(true);
    failure.set('');
    props.ask(question).catch((reason) => {
      failure.set(renderText(errorText(reason, 'Could not ask the side question.')));
      asking.set(false);
    });
  };
  return (
    <View
      ref={(node) => {
        unbind?.();
        unbind = node
          ? keymap.bind('escape', () => props.close(), { when: 'always', within: node })
          : undefined;
      }}
    >
      <SideHeader title={() => ''} close={props.close} />
      <If when={props.quotes.length > 0}>
        <View style={{ paddingTop: INSET, paddingHorizontal: INSET }}>
          <SideQuotes quotes={props.quotes} />
        </View>
      </If>
      <InputRow
        label={tr('Ask a side question')}
        placeholder={props.quotes.length > 0 ? tr('Ask about this') : tr('Ask about this reply')}
        value={text()}
        readonly={asking()}
        change={(value) => text.set(value)}
        submit={ask}
        action={
          <IconButton
            label={tr('Send message')}
            icon={asking() ? 'loader' : 'send'}
            disabled={asking() || text().trim() === ''}
            onPress={ask}
          />
        }
      />
      <If when={failure() !== ''}>
        <Text
          style={[
            { ...captionTextStyle, color: C.danger, paddingHorizontal: INSET, paddingBottom: 12 },
            { userSelect: 'text' },
          ]}
        >
          {failure()}
        </Text>
      </If>
    </View>
  );
}

/** A side question card's first row: what it is, and the ways out of it. */
export function SideHeader(props: { title(): string; expand?(): void; close(): void }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 40,
        paddingLeft: 12,
        paddingRight: 4,
        borderBottomWidth: 1,
        borderBottomColor: C.line,
      }}
    >
      <Icon name="ask" color={C.muted} size={14} />
      <Text
        style={[
          { ...captionTextStyle, flex: 1, minWidth: 0, color: C.secondary, fontWeight: '600' },
          { numberOfLines: 1, textOverflow: 'ellipsis' },
        ]}
      >
        {props.title() || tr('Side question')}
      </Text>
      <If when={props.expand !== undefined}>
        <IconButton label={tr('Open as a conversation')} icon="expand" onPress={props.expand!} />
      </If>
      <IconButton label={tr('Close side question')} icon="close" onPress={props.close} />
    </View>
  );
}

/** One reaction: it springs when pressed, bursts, and then does what it says. */
function Reaction(props: {
  emoji: string;
  label: string;
  /** The label stands beside the emoji; without it the tooltip carries it. */
  labelled?: boolean;
  disabled?: boolean;
  act(): void;
}) {
  const scale = createAnimatedValue(1);
  const tilt = createAnimatedValue(0);
  const burst = signal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => {
    clearTimeout(timer);
    scale.stop();
    tilt.stop();
  });
  const press = () => {
    if (timer !== undefined) return;
    if (!motionEnabled()) return props.act();
    scale.stop();
    tilt.stop();
    scale.set(0.78);
    tilt.set(-12);
    void scale.spring(1, ROOM_SPRING.pillBounce);
    void tilt.spring(0, ROOM_SPRING.pillTilt);
    burst.set(burst() + 1);
    // The reaction is seen before what it does takes its place.
    timer = setTimeout(() => {
      timer = undefined;
      props.act();
    }, 220);
  };
  return (
    <View style={{ position: 'relative' }}>
      <If when={burst() > 0}>
        <Each of={[burst()]} key={(id) => id}>
          {() => <RoomReactionBurst emoji={props.emoji} onDone={() => burst.set(0)} />}
        </Each>
      </If>
      <Button
        accessibilityLabel={props.label}
        tooltip={props.labelled ? undefined : textTooltip(() => props.label)}
        disabled={props.disabled}
        onPress={press}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          height: 28,
          paddingHorizontal: props.labelled ? 10 : 7,
          borderRadius: 14,
          backgroundColor: props.labelled ? C.card : 'transparent',
        }}
        hoverStyle={{ backgroundColor: props.labelled ? C.cardRaised : C.card }}
        activeStyle={{ backgroundColor: C.pressed }}
        focusStyle={quietFocusStyle()}
        disabledStyle={controlDisabledStyle}
      >
        <Text
          style={{
            fontSize: 15,
            lineHeight: 20,
            transform: [
              { scale },
              {
                rotate: tilt.interpolate({ inputRange: [-12, 0], outputRange: ['-12deg', '0deg'] }),
              },
            ],
          }}
        >
          {props.emoji}
        </Text>
        <If when={props.labelled}>
          <Text style={{ ...captionTextStyle, color: C.secondary }}>{props.label}</Text>
        </If>
      </Button>
    </View>
  );
}

/**
 * What can be done with a side question's answer in one press: ask on with a
 * ready follow-up, or settle where the side question goes.
 */
export function SideReactions(props: {
  followUp(item: SideFollowUp): void;
  attach(): void;
  /** Whether the reference was put in the main draft. */
  attached(): boolean;
  resolve(): void;
  archive(): void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: INSET - 4,
        paddingTop: 8,
        paddingBottom: 8,
        // With the input under it, a band apart from the answer that scrolls above.
        borderTopWidth: 1,
        borderTopColor: C.line,
        backgroundColor: C.panel,
      }}
    >
      <Each of={sideFollowUps()} key={(item) => item.emoji}>
        {(item) => (
          <Reaction
            labelled
            emoji={item().emoji}
            label={item().label}
            act={() => props.followUp(item())}
          />
        )}
      </Each>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 'auto' }}>
        <Reaction
          emoji="📎"
          label={props.attached() ? tr('In the main draft') : tr('Bring to the main conversation')}
          disabled={props.attached()}
          act={props.attach}
        />
        <Reaction emoji="👌" label={tr('Got it, close')} act={props.resolve} />
        <Reaction emoji="🗑️" label={tr('Discard this side question')} act={props.archive} />
      </View>
    </View>
  );
}

/** A side question card's input, under what was asked in it. */
export function SideComposer(props: {
  session(): ComposerSession<JSX.Element> | null;
  stop(): void;
  attach(node: InputRef): void;
}) {
  let editor: InputRef;
  const running = () => (props.session()?.run() ?? null) !== null;
  const failure = () => {
    const session = props.session();
    if (!session) return '';
    return session.error() || session.sends().find((send) => send.state === 'failed')?.detail || '';
  };
  const blockWarning = () => {
    const block = props.session()?.sendBlock() ?? null;
    return block && (block.kind === 'attachments' || block.kind === 'draft') ? block.message : '';
  };
  const notice = () => failure() || blockWarning();
  const canSend = () => {
    const session = props.session();
    return (
      session !== null &&
      session.sendBlock() === null &&
      hasComposerContent(session.draft().trim(), session.attachments.files(), session.quotes())
    );
  };
  const send = () => {
    const session = props.session();
    if (!session || !canSend()) return;
    session.submit({ text: session.draft() });
  };
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.panel }}>
      <If when={(props.session()?.quotes().length ?? 0) > 0}>
        <View style={{ paddingHorizontal: INSET, paddingTop: 10 }}>
          <DraftQuotes owner={props.session()!} focusEditor={() => editor.focus()} />
        </View>
      </If>
      <InputRow
        attach={(node) => {
          editor = node;
          props.attach(node);
        }}
        label={tr('Ask in the side question')}
        placeholder={tr('Ask a follow-up')}
        value={props.session()?.draft() ?? ''}
        readonly={!(props.session()?.editable() ?? false)}
        change={(value) => props.session()?.changeDraft(value)}
        submit={send}
        action={
          <If
            when={running()}
            else={
              <IconButton
                label={tr('Send message')}
                icon="send"
                disabled={!canSend()}
                onPress={send}
              />
            }
          >
            <IconButton label={tr('Stop')} icon="stop" onPress={props.stop} />
          </If>
        }
      />
      <If when={notice() !== ''}>
        <Text
          style={[
            {
              ...captionTextStyle,
              color: failure() ? C.danger : C.warning,
              paddingHorizontal: INSET,
              paddingBottom: 12,
            },
            { userSelect: 'text' },
          ]}
        >
          {notice()}
        </Text>
      </If>
    </View>
  );
}

/**
 * The side questions asked beside a reply, under it, with what each is doing: each opens
 * its card. They stay when the reply's actions are hidden, so a reply shows what was asked
 * of it.
 */
export function SideNotes(props: {
  /**
   * Those not underlined in the reply (asked about all of it, or about text not found in
   * it), and underlined ones that are working, waiting or unread.
   */
  questions(): readonly Pick<AgentSession, 'id' | 'title' | 'activity' | 'hasUnread'>[];
  /** The side question whose card is open. */
  shown(): string | null;
  open(sessionId: string): void;
}) {
  return (
    <If when={props.questions().length > 0}>
      <View style={{ alignItems: 'flex-start', gap: 2, marginLeft: -8, marginBottom: 4 }}>
        <Each of={props.questions()} key={(item) => item.id}>
          {(item) => (
            <Button
              accessibilityLabel={tr('Side question: {title}', { title: item().title })}
              onPress={() => props.open(item().id)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                maxWidth: '100%',
                height: 28,
                paddingHorizontal: 8,
                borderRadius: radius(8),
                backgroundColor: props.shown() === item().id ? C.card : 'transparent',
              }}
              hoverStyle={{ backgroundColor: C.card }}
              activeStyle={{ backgroundColor: C.cardRaised }}
              focusStyle={quietFocusStyle()}
            >
              <Text style={{ ...captionTextStyle, color: C.accentText }}>↳</Text>
              <Text
                style={[
                  {
                    ...captionTextStyle,
                    flexShrink: 1,
                    color: props.shown() === item().id ? C.text : C.secondary,
                  },
                  { numberOfLines: 1, textOverflow: 'ellipsis' },
                ]}
              >
                {item().title}
              </Text>
              {/* The same states the sidebar shows for a conversation. */}
              <If when={item().activity === 'waiting'}>
                <Text style={{ ...captionTextStyle, color: C.warning, flexShrink: 0 }}>
                  {sessionStatusCaption.waiting}
                </Text>
              </If>
              <If when={item().activity === 'working'}>
                <LoadingIndicator size={12} label={sessionStatusCaption.working} />
              </If>
              <If
                when={
                  item().activity !== 'waiting' &&
                  item().activity !== 'working' &&
                  item().hasUnread &&
                  props.shown() !== item().id
                }
              >
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent }} />
              </If>
            </Button>
          )}
        </Each>
      </View>
    </If>
  );
}

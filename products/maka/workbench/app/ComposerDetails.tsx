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
  computed,
  effect,
  inputAction,
  platform,
  signal,
  Text,
  View,
  windowSize,
} from 'nsh';
import { Button } from 'nsh/base';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/composer-view.js';
import { createChecklist } from './Checklist';
import { createComputerAppControls } from './ComputerAppControls';
import { createMessagesDock } from './MessagesDock';
import { createGoalContent, goalStatusLabel } from './GoalDialog';
import { LoadingIndicator } from './Loading';
import { Icon } from './Icon';
import { tr } from './locale';
import { C, captionTextStyle, controlStyle, textTooltip } from './ui';

// The composer card's corner radius on the desktop. The strip sits on the
// card's straight top edge, inside its rounded corners.
const composerCorner = 24;

export function ComposerDetails(props: {
  session: Pick<
    ComposerSession,
    | 'sessionId'
    | 'checklist'
    | 'computerAccess'
    | 'queue'
    | 'connected'
    | 'goal'
    | 'sends'
    | 'retrySend'
    | 'checkSend'
    | 'dismissSend'
  >;
}) {
  const session = props.session;
  const height = () => windowSize().height / 4;
  const goal = () => session.goal?.view()?.current;
  const renderGoal = session.goal ? createGoalContent({ goal: session.goal }) : null;
  const todo = createChecklist(session.checklist, height, session.sessionId);
  const panels = {
    goal: {
      shown: () => !!goal(),
      summary: () => tr(goalStatusLabel(goal()!.status)),
      preview: () => goal()!.objective,
      problem: () =>
        !!session.goal?.error() ||
        goal()?.status === 'blocked' ||
        goal()?.status === 'budget_limited',
      content: () => (
        <View style={{ minHeight: 0, flexShrink: 1, padding: 16 }}>{renderGoal!()}</View>
      ),
    },
    todo,
    computer: createComputerAppControls(session.computerAccess, height),
    messages: createMessagesDock(session, height),
  };
  type Panel = keyof typeof panels;
  const keys: Panel[] = ['goal', 'todo', 'computer', 'messages'];
  const available = computed(() => keys.filter((key) => panels[key].shown()));
  const selected = signal<Panel | null>(null);
  const labels = {
    goal: () => tr('Goal'),
    todo: () => tr('Todo'),
    computer: () => tr('Computer access'),
    messages: () => tr('Messages'),
  };
  const icons = {
    goal: 'statusPending',
    computer: 'shield',
    messages: 'queue',
  } as const;
  const accessibilityLabels = {
    goal: () => `${tr('Goal progress')}: ${panels.goal.summary()}`,
    todo: () => tr('Toggle conversation todo'),
    computer: () => tr('Toggle computer access'),
    messages: () => tr('Messages'),
  };
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const toggle = (key: Panel) => {
    if (alive && panels[key].shown()) selected.set(selected() === key ? null : key);
  };
  const hideTodo = () => {
    if (alive && todo.shown()) todo.hide();
  };
  effect(() => {
    const current = selected();
    if (current !== null && !panels[current].shown()) selected.set(null);
  });
  // The list opens above the row on the desktop, so the row stays under the
  // pointer and the chevron points the way the list opens.
  const chevron = (key: Panel) => (
    <Icon
      name={selected() === key ? 'down' : platform.isTerminal ? 'right' : 'up'}
      color={C.muted}
    />
  );
  const mark = (key: Panel) =>
    key === 'todo' ? (
      todo.mark()
    ) : (
      <If
        when={
          (key === 'goal' && goal()?.status === 'active') ||
          (key === 'messages' && session.sends().some((item) => item.busy))
        }
        else={
          <Icon
            name={key === 'goal' && goal()?.status === 'achieved' ? 'statusSuccess' : icons[key]}
            color={panels[key].problem() ? C.warning : C.secondary}
          />
        }
      >
        <LoadingIndicator color={C.secondary} />
      </If>
    );
  const summary = (key: Panel) => (
    <Text style={{ ...captionTextStyle, color: panels[key].problem() ? C.warning : C.muted }}>
      {panels[key].summary()}
    </Text>
  );
  // On the desktop the checklist's current item says what is happening, so it
  // reads as text. Beside chips it wraps to its own line rather than shrink away.
  const preview = (key: Panel, besideChips: boolean) => (
    <Text
      style={[
        {
          ...captionTextStyle,
          flex: 1,
          minWidth: besideChips ? 120 : 0,
          color: panels[key].problem()
            ? C.warning
            : key === 'todo' && !platform.isTerminal
              ? C.text
              : C.muted,
        },
        { numberOfLines: 1 },
      ]}
    >
      {panels[key].preview()}
    </Text>
  );
  // What follows the chips: the checklist's current item on the desktop; in the
  // terminal, as before, the only panel's preview while it is closed.
  const lead = (): Panel | null =>
    platform.isTerminal
      ? available().length === 1 && selected() === null
        ? available()[0]
        : null
      : todo.shown()
        ? 'todo'
        : null;
  const button = (key: Panel, wide: boolean) => (
    <Button
      accessibilityLabel={accessibilityLabels[key]()}
      tooltip={textTooltip(panels[key].preview)}
      selected={selected() === key}
      onPress={inputAction(toggle, key)}
      style={{
        ...controlStyle,
        flexDirection: 'row',
        gap: 8,
        alignItems: 'center',
        ...(wide ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }),
        backgroundColor: !wide && selected() === key ? C.raised : 'transparent',
      }}
      hoverStyle={{ backgroundColor: C.raised }}
      focusStyle={{ backgroundColor: C.line }}
    >
      {mark(key)}
      {wide && key === 'todo' ? (
        <>
          {preview(key, false)}
          {summary(key)}
        </>
      ) : (
        <>
          <Text style={{ ...captionTextStyle, color: C.text }}>{labels[key]()}</Text>
          {summary(key)}
          {wide ? preview(key, false) : null}
        </>
      )}
      {chevron(key)}
    </Button>
  );
  const row = () => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4, flexShrink: 0 }}>
      <If
        when={available().length === 1 && !platform.isTerminal}
        else={
          <View
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Each of={available()} key={(key) => key}>
              {(key) => button(key(), false)}
            </Each>
            <Each of={lead() === null ? [] : [lead()!]} key={(key) => key}>
              {(key) => preview(key(), true)}
            </Each>
          </View>
        }
      >
        <Each of={available()} key={(key) => key}>
          {(key) => button(key(), true)}
        </Each>
      </If>
      <If when={todo.shown()}>
        <Button
          accessibilityLabel={tr('Hide todo')}
          tooltip={textTooltip(() => tr('Hide todo'))}
          onPress={inputAction(hideTodo, null)}
          style={{ ...controlStyle, paddingHorizontal: 8, flexShrink: 0 }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={{ backgroundColor: C.line }}
        >
          <Icon name="close" color={C.muted} />
        </Button>
      </If>
    </View>
  );
  const detail = () => (
    <Each of={selected() === null ? [] : [selected()!]} key={(key) => key}>
      {(key) => (
        <View
          style={{
            minHeight: 0,
            flexShrink: 1,
            maxHeight: selected() === 'goal' ? windowSize().height / 2 : height(),
            ...(platform.isTerminal
              ? { borderTopWidth: 1, borderTopColor: C.line }
              : { borderBottomWidth: 1, borderBottomColor: C.line }),
          }}
        >
          {panels[key()].content()}
        </View>
      )}
    </Each>
  );
  return (
    <If when={available().length > 0}>
      <View
        accessibilityLabel={tr('Conversation details')}
        style={{
          minHeight: 0,
          flexShrink: 1,
          backgroundColor: C.surface,
          overflow: 'hidden',
          ...(platform.isTerminal
            ? { marginBottom: 16, borderWidth: 1, borderColor: C.line, borderRadius: 12 }
            : {
                // A tab on the composer card rather than a second card above it.
                marginHorizontal: composerCorner,
                borderTopWidth: 1,
                borderLeftWidth: 1,
                borderRightWidth: 1,
                borderBottomWidth: 0,
                borderColor: C.line,
                borderTopLeftRadius: 12,
                borderTopRightRadius: 12,
              }),
        }}
      >
        {platform.isTerminal ? null : detail()}
        {row()}
        {platform.isTerminal ? detail() : null}
      </View>
    </If>
  );
}

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
  type OtherPanel = Exclude<Panel, 'todo'>;
  const keys: Panel[] = ['goal', 'todo', 'computer', 'messages'];
  const available = computed(() => keys.filter((key) => panels[key].shown()));
  const selected = signal<Panel | null>(null);
  const labels = {
    goal: () => tr('Goal'),
    todo: () => tr('Todo'),
    computer: () => tr('Computer access'),
    messages: () => tr('Messages'),
  };
  const icons: Record<OtherPanel, 'statusPending' | 'shield' | 'queue'> = {
    goal: 'statusPending',
    computer: 'shield',
    messages: 'queue',
  };
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
      name={selected() === key ? 'down' : platform.idiom === 'terminal' ? 'right' : 'up'}
      color={C.muted}
    />
  );
  const otherMark = (key: OtherPanel) => (
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
    <If when={!!panels[key].summary()}>
      <Text style={{ ...captionTextStyle, color: panels[key].problem() ? C.warning : C.muted }}>
        {panels[key].summary()}
      </Text>
    </If>
  );
  const preview = (key: Panel) => (
    <Text
      style={[
        {
          ...captionTextStyle,
          flex: 1,
          minWidth: 0,
          color: panels[key].problem()
            ? C.warning
            : key === 'todo' && platform.idiom !== 'terminal'
              ? C.text
              : C.muted,
        },
        { numberOfLines: 1 },
      ]}
    >
      {panels[key].preview()}
    </Text>
  );
  const hideButton = () => (
    <Button
      accessibilityLabel={tr('Hide todo')}
      tooltip={textTooltip(() => tr('Hide todo'))}
      onPress={inputAction(hideTodo, null)}
      style={{
        ...controlStyle,
        paddingHorizontal: 8,
        flexShrink: 0,
        backgroundColor: 'transparent',
      }}
      hoverStyle={{ backgroundColor: C.cardRaised }}
      focusStyle={{ backgroundColor: C.line }}
    >
      <Icon name="close" color={C.muted} />
    </Button>
  );
  // Keep Todo, its active step, and its Hide button inside one cohesive unit so
  // sibling panels (Messages, Computer access) never separate Todo from its text
  // or leave an ambiguous corner close button above another open panel.
  const todoItem = () => {
    const single = () => available().length === 1;
    if (platform.idiom === 'terminal') {
      return (
        <View
          style={{
            ...(single() ? { flex: 1, minWidth: 0, gap: 4 } : { flexShrink: 0 }),
            flexDirection: 'row',
            alignItems: 'center',
            borderRadius: controlStyle.borderRadius,
            backgroundColor: !single() && selected() === 'todo' ? C.cardRaised : 'transparent',
          }}
        >
          <Button
            accessibilityLabel={accessibilityLabels.todo()}
            tooltip={textTooltip(panels.todo.preview)}
            selected={selected() === 'todo'}
            onPress={inputAction(toggle, 'todo')}
            style={{
              ...controlStyle,
              flexDirection: 'row',
              gap: 8,
              alignItems: 'center',
              flexShrink: 0,
              backgroundColor: single() && selected() === 'todo' ? C.cardRaised : 'transparent',
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            focusStyle={{ backgroundColor: C.line }}
          >
            {todo.mark()}
            <Text style={{ ...captionTextStyle, color: C.text }}>{labels.todo()}</Text>
            {summary('todo')}
            {chevron('todo')}
          </Button>
          <If when={single()}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
              <If when={selected() === null}>{preview('todo')}</If>
            </View>
          </If>
          {hideButton()}
        </View>
      );
    }
    return (
      <View
        style={{
          flex: 1,
          minWidth: single() ? 0 : 200,
          flexDirection: 'row',
          alignItems: 'center',
          gap: single() ? 4 : 0,
          borderRadius: controlStyle.borderRadius,
          backgroundColor: !single() && selected() === 'todo' ? C.cardRaised : 'transparent',
        }}
      >
        <Button
          accessibilityLabel={accessibilityLabels.todo()}
          tooltip={textTooltip(panels.todo.preview)}
          selected={selected() === 'todo'}
          onPress={inputAction(toggle, 'todo')}
          style={{
            ...controlStyle,
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            gap: 8,
            alignItems: 'center',
            backgroundColor: 'transparent',
          }}
          hoverStyle={{ backgroundColor: C.cardRaised }}
          focusStyle={{ backgroundColor: C.line }}
        >
          {todo.mark()}
          {preview('todo')}
          {summary('todo')}
          {chevron('todo')}
        </Button>
        {hideButton()}
      </View>
    );
  };
  const otherItem = (key: OtherPanel) => {
    const singleDesktop = () => available().length === 1 && platform.idiom !== 'terminal';
    const singleTerminal = () => available().length === 1 && platform.idiom === 'terminal';
    return (
      <>
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
            ...(singleDesktop() ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }),
            backgroundColor: !singleDesktop() && selected() === key ? C.cardRaised : 'transparent',
          }}
          hoverStyle={{ backgroundColor: C.cardRaised }}
          focusStyle={{ backgroundColor: C.line }}
        >
          {otherMark(key)}
          <Text style={{ ...captionTextStyle, color: C.text }}>{labels[key]()}</Text>
          {summary(key)}
          {singleDesktop() ? preview(key) : null}
          {chevron(key)}
        </Button>
        <If when={singleTerminal() && selected() === null}>{preview(key)}</If>
      </>
    );
  };
  const row = () => (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: available().length > 1 ? 'wrap' : 'nowrap',
        alignItems: 'center',
        gap: 4,
        padding: 4,
        flexShrink: 0,
      }}
    >
      <Each of={available()} key={(key) => key}>
        {(key) => {
          const current = key();
          return current === 'todo' ? todoItem() : otherItem(current);
        }}
      </Each>
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
            ...(platform.idiom === 'terminal'
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
          backgroundColor: C.card,
          overflow: 'hidden',
          ...(platform.idiom === 'terminal'
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
        {platform.idiom === 'terminal' ? null : detail()}
        {row()}
        {platform.idiom === 'terminal' ? detail() : null}
      </View>
    </If>
  );
}

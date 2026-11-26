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
import type {
  ComposerSession,
  ComposerShelfStatus,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import { ComposerShelf, ComposerShelfRow } from './Feedback';
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
    | 'editSend'
    | 'checkSend'
    | 'dismissSend'
  >;
  status?(): ComposerShelfStatus | null;
}) {
  const session = props.session;
  const height = () => windowSize().height / 4;
  const goal = () => session.goal?.view()?.current;
  const renderGoal = session.goal ? createGoalContent({ goal: session.goal }) : null;
  const todo = createChecklist(session.checklist, height, session.sessionId);
  const computer = createComputerAppControls(session.computerAccess, height);
  const messages = createMessagesDock(session, height);

  let alive = true;
  cleanup(() => {
    alive = false;
  });

  const dismissGoal = () => {
    if (alive) void session.goal?.change('dismiss');
  };
  const hideTodo = () => {
    if (alive && todo.shown()) todo.hide();
  };

  const panels = {
    goal: {
      shown: () => !!goal() && !goal()!.dismissed,
      mark: () => (
        <If
          when={goal()?.status === 'active' || !!goal()?.pending}
          else={
            <Icon
              name={
                goal()?.status === 'achieved'
                  ? 'statusSuccess'
                  : goal()?.status === 'cancelled'
                    ? 'statusStopped'
                    : 'goal'
              }
              color={
                !!session.goal?.error() ||
                goal()?.status === 'blocked' ||
                goal()?.status === 'budget_limited'
                  ? C.warning
                  : goal()?.status === 'achieved'
                    ? C.success
                    : C.secondary
              }
            />
          }
        >
          <LoadingIndicator color={C.secondary} />
        </If>
      ),
      summary: () => tr(goalStatusLabel(goal()!.status)),
      preview: () => goal()!.objective,
      problem: () =>
        !!session.goal?.error() ||
        goal()?.status === 'blocked' ||
        goal()?.status === 'budget_limited',
      dismiss: () => {
        const current = goal();
        return current &&
          !current.pending &&
          (current.status === 'achieved' || current.status === 'cancelled')
          ? dismissGoal
          : null;
      },
      dismissLabel: () => tr('Dismiss Goal'),
      content: () => (
        <View style={{ minHeight: 0, flexShrink: 1, padding: 16 }}>{renderGoal!()}</View>
      ),
    },
    todo: {
      ...todo,
      dismiss: () => (todo.shown() ? hideTodo : null),
      dismissLabel: () => tr('Hide todo'),
    },
    computer: {
      ...computer,
      mark: () => <Icon name="shield" color={computer.problem() ? C.warning : C.secondary} />,
      dismiss: () => null as (() => void) | null,
      dismissLabel: () => '',
    },
    messages: {
      ...messages,
      mark: () => (
        <If
          when={session.sends().some((item) => item.busy)}
          else={<Icon name="queue" color={messages.problem() ? C.warning : C.secondary} />}
        >
          <LoadingIndicator color={C.secondary} />
        </If>
      ),
    },
  };
  type Panel = keyof typeof panels;
  const keys: Panel[] = ['goal', 'todo', 'computer', 'messages'];
  const available = computed(() => keys.filter((key) => panels[key].shown()));
  const selected = signal<Panel | null>(null);
  const labels: Record<Panel, () => string> = {
    goal: () => tr('Goal'),
    todo: () => tr('Todo'),
    computer: () => tr('Computer access'),
    messages: () => tr('Messages'),
  };
  const accessibilityLabels: Record<Panel, () => string> = {
    goal: () => `${tr('Goal progress')}: ${panels.goal.summary()}`,
    todo: () => tr('Toggle conversation todo'),
    computer: () => tr('Toggle computer access'),
    messages: () => tr('Messages'),
  };

  const toggle = (key: Panel) => {
    if (alive && panels[key].shown()) selected.set(selected() === key ? null : key);
  };
  const dismiss = (key: Panel) => {
    if (!alive) return;
    panels[key].dismiss()?.();
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
  const dismissButton = (key: Panel) => (
    <Button
      accessibilityLabel={panels[key].dismissLabel()}
      tooltip={textTooltip(panels[key].dismissLabel)}
      onPress={inputAction(dismiss, key)}
      style={{
        ...controlStyle,
        paddingHorizontal: 8,
        flexShrink: 0,
        backgroundColor: 'transparent',
      }}
      hoverStyle={{ backgroundColor: C.cardRaised }}
      focusStyle={{ backgroundColor: C.pressed }}
    >
      <Icon name="close" color={C.muted} />
    </Button>
  );

  // Keep each tab, its inline preview, and its optional dismiss button inside
  // one cohesive unit so sibling tabs never separate a tab from its close action.
  const panelItem = (key: Panel) => {
    const single = () => available().length === 1;
    const hasDismiss = () => panels[key].dismiss() !== null;
    if (platform.idiom === 'terminal') {
      return (
        <View
          style={{
            ...(single() ? { flex: 1, minWidth: 0, gap: 4 } : { flexShrink: 0 }),
            flexDirection: 'row',
            alignItems: 'center',
            borderRadius: controlStyle.borderRadius,
            backgroundColor: !single() && selected() === key ? C.cardRaised : 'transparent',
          }}
        >
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
              flexShrink: 0,
              backgroundColor: single() && selected() === key ? C.cardRaised : 'transparent',
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            focusStyle={{ backgroundColor: C.pressed }}
          >
            {panels[key].mark()}
            <Text style={{ ...captionTextStyle, color: C.text }}>{labels[key]()}</Text>
            {summary(key)}
            {chevron(key)}
          </Button>
          <If when={single()}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
              <If when={selected() === null}>{preview(key)}</If>
            </View>
          </If>
          <If when={hasDismiss()}>{dismissButton(key)}</If>
        </View>
      );
    }
    const stretch = () => key === 'todo' || single();
    return (
      <View
        style={{
          ...(key === 'todo'
            ? { flex: 1, minWidth: single() ? 0 : 200 }
            : single()
              ? { flex: 1, minWidth: 0 }
              : { flexShrink: 0 }),
          flexDirection: 'row',
          alignItems: 'center',
          gap: single() && hasDismiss() ? 4 : 0,
          borderRadius: controlStyle.borderRadius,
          backgroundColor: !single() && selected() === key ? C.cardRaised : 'transparent',
        }}
      >
        <Button
          accessibilityLabel={accessibilityLabels[key]()}
          tooltip={textTooltip(panels[key].preview)}
          selected={selected() === key}
          onPress={inputAction(toggle, key)}
          style={{
            ...controlStyle,
            ...(stretch() ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }),
            flexDirection: 'row',
            gap: 8,
            alignItems: 'center',
            backgroundColor: 'transparent',
          }}
          hoverStyle={{ backgroundColor: C.cardRaised }}
          focusStyle={{ backgroundColor: C.pressed }}
        >
          {panels[key].mark()}
          {key === 'todo' ? (
            <>
              {preview('todo')}
              {summary('todo')}
            </>
          ) : (
            <>
              <Text style={{ ...captionTextStyle, color: C.text }}>{labels[key]()}</Text>
              {summary(key)}
              {single() ? preview(key) : null}
            </>
          )}
          {chevron(key)}
        </Button>
        <If when={hasDismiss()}>{dismissButton(key)}</If>
      </View>
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
        {(key) => panelItem(key())}
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
  const status = () => props.status?.() ?? null;
  const statusRow = () => (
    <If when={status() !== null}>
      <ComposerShelfRow
        tone={status()!.tone}
        message={status()!.message}
        detail={status()!.detail}
        action={status()!.action}
        secondaryAction={status()!.secondaryAction}
        onDismiss={status()!.onDismiss}
        divided={available().length > 0}
      />
    </If>
  );
  return (
    <If when={available().length > 0 || status() !== null}>
      <ComposerShelf inset={composerCorner} accessibilityLabel={tr('Conversation details')}>
        {statusRow()}
        <If when={available().length > 0}>
          {platform.idiom === 'terminal' ? null : detail()}
          {row()}
          {platform.idiom === 'terminal' ? detail() : null}
        </If>
      </ComposerShelf>
    </If>
  );
}

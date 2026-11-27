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
  announce,
  batch,
  effect,
  computed,
  fontScale,
  signal,
  Text,
  token,
  View,
  windowSize,
  safeAreaInsets,
  type ScrollRef,
} from 'nsh';
import { AlertDialog, Input } from 'nsh/base';
import type { AgentGoalDetail } from '../../bridge';
import { trimHostWhitespace } from '../../hostText';
import { currentLocale, formatCount, tr } from '../../locale';
import {
  canResumeWithBudget,
  goalStatus,
  parseGoalBudget,
  terminalGoal,
  type GoalController,
} from '../../state/goal';
import { hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton } from '../../ui';
import { ChatSheet } from './ChatSheet';

type Edit =
  | { kind: 'create'; expected: AgentGoalDetail | null }
  | { kind: 'budget' | 'resume'; expected: AgentGoalDetail };

const initialBudget = (edit: Edit | null) =>
  edit && edit.kind !== 'create' ? String(edit.expected.tokenBudget ?? '') : '';

export function GoalSheet(props: { goal: GoalController; onClose: () => void }) {
  const goal = props.goal;
  const edit = signal<Edit | null>(null);
  const submitting = signal<Edit | null>(null);
  const objective = signal('');
  const budget = signal('');
  const composing = signal(false);
  const confirming = signal(false);
  let scroll: ScrollRef | undefined;
  const current = goal.current;
  const form = computed<Edit | null>(
    () => edit() ?? (current() ? null : { kind: 'create', expected: null }),
  );
  const creating = () => form()?.kind === 'create';
  const title = () =>
    creating() ? tr('New Goal') : form() ? tr('Token Budget') : tr('Goal Details');
  const finishingEdit = () => submitting() !== null && submitting() === edit();
  const busy = () => goal.busy() || finishingEdit() || confirming();
  const closeDisabled = () => confirming() || (goal.busy() && dirty());
  const disabled = () => !goal.writable() || busy();
  const dirty = () =>
    !!form() && (composing() || objective() !== '' || budget() !== initialBudget(form()));
  const backToDetails = () => {
    batch(() => {
      composing.set(false);
      objective.set('');
      budget.set('');
      edit.set(null);
    });
    scroll?.scrollTo({ y: 0, animated: false });
  };
  const begin = (next: Edit) => {
    hapticSelection();
    batch(() => {
      goal.clearNotice();
      budget.set(initialBudget(next));
      edit.set(next);
    });
    scroll?.scrollTo({ y: 0, animated: false });
  };
  const rejectEdit = async () => {
    if (closeDisabled()) return;
    if (dirty()) {
      confirming.set(true);
      try {
        const { action } = await AlertDialog.show({
          title: tr('Discard goal edits?'),
          actions: [
            { id: 'keep', label: tr('Keep Editing'), role: 'cancel' },
            { id: 'discard', label: tr('Discard Edits'), role: 'destructive' },
          ],
        });
        if (action !== 'discard') return;
      } finally {
        confirming.set(false);
      }
    }
    if (form() && current()) backToDetails();
    else props.onClose();
  };
  const cancelGoal = async () => {
    const expected = current();
    if (!expected || disabled()) return;
    confirming.set(true);
    try {
      const { action } = await AlertDialog.show({
        title: tr('Cancel this goal?'),
        description: tr('The agent won’t start any more turns for this goal.'),
        actions: [
          { id: 'keep', label: tr('Keep Goal'), role: 'cancel' },
          { id: 'cancel-goal', label: tr('Cancel Goal'), role: 'destructive' },
        ],
      });
      if (action === 'cancel-goal') await goal.change({ action: 'cancel', expected });
    } finally {
      confirming.set(false);
    }
  };

  const parsed = () => parseGoalBudget(budget());
  const sameRecord = () =>
    form()?.expected?.id === current()?.id && form()?.expected?.revision === current()?.revision;
  const valid = () => {
    const editing = form();
    const value = parsed();
    return (
      editing &&
      value !== undefined &&
      sameRecord() &&
      (editing.kind !== 'create' || (!composing() && !!trimHostWhitespace(objective()))) &&
      (editing.kind !== 'resume' || canResumeWithBudget(current()!, value))
    );
  };
  const submit = async () => {
    const editing = form();
    const tokenBudget = parsed();
    if (!editing || tokenBudget === undefined || !valid() || disabled()) return;
    const command =
      editing.kind === 'create'
        ? {
            action: 'create' as const,
            expected: editing.expected,
            objective: objective(),
            tokenBudget,
          }
        : {
            action: editing.kind === 'resume' ? ('resume' as const) : ('set_budget' as const),
            expected: editing.expected,
            tokenBudget,
          };
    batch(() => {
      edit.set(editing);
      submitting.set(editing);
    });
    try {
      // The watch can settle the controller before this editor's readback finishes.
      if ((await goal.change(command)) && edit() === editing) backToDetails();
    } finally {
      if (submitting() === editing) submitting.set(null);
    }
  };

  // Keep an in-progress create draft even if another device creates a Goal.
  const pinEdit = () => {
    if (!edit()) edit.set(form());
  };
  const editObjective = (value: string) => {
    pinEdit();
    objective.set(value);
  };
  const editBudget = (value: string) => {
    pinEdit();
    budget.set(value);
  };
  effect(() => {
    const message = goal.notice();
    if (message) announce(message);
  });
  const applyToCurrent = (action: 'complete' | 'dismiss' | 'pause' | 'resume') => {
    const expected = current();
    if (expected && !disabled()) void goal.change({ action, expected });
  };
  const limited = () => current()?.status === 'budget_limited';
  const usageMissing = () => !!current()?.consumed.missing;
  const done = () => current() !== null && terminalGoal(current()!);
  const retryTime = () => {
    const record = current();
    return record?.status === 'active' && record.retryAt && record.retryAt > Date.now()
      ? new Date(record.retryAt).toLocaleString(currentLocale())
      : null;
  };
  const firstNote = () => current()?.note || current()?.report?.note || '';
  const otherNote = () => {
    const report = current()?.report?.note;
    return report && report !== firstNote() ? report : '';
  };
  const remaining = () => {
    const record = current()!;
    if (record.tokenBudget == null) return tr('Unlimited');
    if (record.consumed.missing > 0) return tr('Unknown · Incomplete usage');
    return record.remainingTokens == null
      ? tr('Unknown')
      : tr('{count} tokens', { count: record.remainingTokens });
  };

  return (
    <ChatSheet
      title={title()}
      scrollId="chat-goal-sheet-scroll"
      scrollRef={(ref) => (scroll = ref)}
      ownHeader
      detent={{ fraction: 0.9 }}
      editing={dirty() || confirming()}
      onClose={props.onClose}
    >
      <View style={{ gap: spacing.sectionGap, paddingVertical: 8 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <Text role="header" style={{ ...type.title2, color: token('foreground'), flexShrink: 1 }}>
            {title()}
          </Text>
          <ActionButton
            title={form() ? tr('Cancel Editing') : tr('Done')}
            variant="glassQuiet"
            testID="goal-close"
            compact
            minHeight={spacing.rowMinHeight}
            disabled={closeDisabled()}
            onPress={() => void rejectEdit()}
          />
        </View>
        <If when={!goal.synced()}>
          <View style={{ gap: 8, alignItems: 'flex-start' }}>
            <GoalHint>{tr('Last synced · Read-only')}</GoalHint>
            <If when={goal.canReconnect()}>
              <GoalAction
                id="reconnect"
                title={tr('Reconnect')}
                disabled={false}
                onPress={goal.reconnectWatch}
              />
            </If>
          </View>
        </If>
        <If when={goal.view()?.enabled === false}>
          <GoalHint>{tr('Goals are turned off on this computer.')}</GoalHint>
        </If>
        <If when={goal.notice()}>
          <GoalHint alert>{goal.notice()}</GoalHint>
        </If>
        <If when={goal.busy() || finishingEdit()}>
          <GoalHint>{tr('Updating goal…')}</GoalHint>
        </If>
        <If when={form()}>
          <View style={{ gap: 16 }}>
            <If when={creating()}>
              <GoalField
                label={tr('Objective')}
                testID="goal-objective"
                multiline
                value={objective()}
                readonly={disabled()}
                onChange={editObjective}
                onComposingChange={(active) => {
                  if (active) pinEdit();
                  composing.set(active);
                }}
              />
            </If>
            <GoalField
              label={creating() ? tr('Token Budget (Optional)') : tr('Token Budget')}
              testID="goal-budget"
              value={budget()}
              readonly={disabled()}
              onChange={editBudget}
            />
            <If when={parsed() === undefined}>
              <GoalHint alert>
                {tr('Enter a positive whole number, or leave it blank for no limit.')}
              </GoalHint>
            </If>
            <If when={form()?.kind === 'resume'}>
              <GoalHint>
                {usageMissing()
                  ? tr('Usage is incomplete. To resume now, remove the limit.')
                  : tr('Set a limit above {count} tokens used, or leave it blank for no limit.', {
                      count: current()!.consumed.known,
                    })}
              </GoalHint>
            </If>
            <If when={creating()}>
              <GoalHint>
                {tr(
                  'The agent continues automatically in later turns. It checks the budget between turns, so the current turn may go over.',
                )}
              </GoalHint>
            </If>
            <If when={!sameRecord()}>
              <GoalHint alert>{tr('The goal changed. Close the editor to review it.')}</GoalHint>
            </If>
            <GoalAction
              id="save"
              title={
                creating()
                  ? tr('Start Goal')
                  : form()?.kind === 'resume'
                    ? tr('Resume Goal')
                    : tr('Save Budget')
              }
              primary
              disabled={disabled() || !valid()}
              onPress={() => void submit()}
            />
          </View>
        </If>
        <If when={!form() && current()}>
          <View style={{ gap: spacing.sectionGap }}>
            <View style={{ gap: 8 }}>
              <Text style={{ ...type.headline, color: token('foreground') }}>
                {goalStatus(current()!.status)}
              </Text>
              <Text style={{ ...type.body, color: token('foreground') }}>
                {current()!.objective}
              </Text>
              <If when={firstNote()}>
                <GoalHint>{firstNote()}</GoalHint>
              </If>
              <If when={otherNote()}>
                <GoalHint>{otherNote()}</GoalHint>
              </If>
              <If when={retryTime()}>
                <GoalHint>{tr('Next attempt: {time}', { time: retryTime()! })}</GoalHint>
              </If>
            </View>
            <If when={goal.view()?.enabled && current()}>
              <View style={{ gap: 8 }}>
                <If when={done()}>
                  <If when={current()!.pending}>
                    <GoalHint>{tr('Waiting for this turn to finish.')}</GoalHint>
                  </If>
                  <GoalAction
                    id="new"
                    title={tr('New Goal')}
                    primary
                    disabled={disabled() || current()!.pending}
                    onPress={() => begin({ kind: 'create', expected: current()! })}
                  />
                </If>
                <If when={limited()}>
                  <GoalHint>
                    {usageMissing()
                      ? tr('Usage is incomplete. To resume now, remove the limit.')
                      : tr(
                          'Set a limit above {count} tokens used, or leave it blank for no limit.',
                          { count: current()!.consumed.known },
                        )}
                  </GoalHint>
                  <If
                    when={usageMissing()}
                    else={
                      <GoalAction
                        id="adjust"
                        title={tr('Adjust Budget & Resume')}
                        primary
                        disabled={disabled()}
                        onPress={() => begin({ kind: 'resume', expected: current()! })}
                      />
                    }
                  >
                    <GoalAction
                      id="remove-limit"
                      title={tr('Remove Limit & Resume')}
                      primary
                      disabled={disabled()}
                      onPress={() =>
                        void goal.change({
                          action: 'resume',
                          expected: current()!,
                          tokenBudget: null,
                        })
                      }
                    />
                  </If>
                </If>
                <If when={!done() && !limited()}>
                  <GoalAction
                    id="toggle"
                    title={current()!.status === 'active' ? tr('Pause Goal') : tr('Resume Goal')}
                    primary
                    disabled={disabled()}
                    onPress={() =>
                      applyToCurrent(current()?.status === 'active' ? 'pause' : 'resume')
                    }
                  />
                </If>
              </View>
            </If>
            <View style={{ gap: 8 }}>
              <GoalMetric label={tr('Turns')} value={formatCount(current()!.iterations)} />
              <GoalMetric
                label={tr('Token Budget')}
                value={
                  current()!.tokenBudget == null
                    ? tr('Unlimited')
                    : tr('{count} tokens', { count: current()!.tokenBudget! })
                }
              />
              <GoalMetric
                label={tr('Used')}
                value={tr(usageMissing() ? 'At least {count} tokens' : '{count} tokens', {
                  count: current()!.consumed.known,
                })}
              />
              <GoalMetric label={tr('Remaining')} value={remaining()} />
              <GoalMetric
                label={tr('Elapsed')}
                value={tr('{count} s', { count: current()!.elapsedSeconds })}
              />
            </View>
            <If when={goal.view()?.enabled}>
              <View style={{ gap: 8 }}>
                <If when={!done() && !limited()}>
                  <GoalAction
                    id="edit-budget"
                    title={tr('Edit Budget')}
                    disabled={disabled()}
                    onPress={() => begin({ kind: 'budget', expected: current()! })}
                  />
                </If>
                <If when={!done() && !current()!.pending}>
                  <GoalAction
                    id="complete"
                    title={tr('Mark Complete')}
                    disabled={disabled()}
                    onPress={() => applyToCurrent('complete')}
                  />
                </If>
                <If when={!done()}>
                  <GoalAction
                    id="cancel"
                    title={tr('Cancel Goal')}
                    destructive
                    disabled={disabled()}
                    onPress={() => void cancelGoal()}
                  />
                </If>
                <If when={done() && !current()!.pending && !current()!.dismissed}>
                  <GoalAction
                    id="dismiss"
                    title={tr('Dismiss Goal Summary')}
                    disabled={disabled()}
                    onPress={() => applyToCurrent('dismiss')}
                  />
                </If>
              </View>
            </If>
          </View>
        </If>
      </View>
    </ChatSheet>
  );
}

function GoalAction(props: {
  id: string;
  title: string;
  disabled: boolean;
  primary?: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <ActionButton
      testID={'goal-' + props.id}
      title={props.title}
      variant={
        props.primary ? 'glassPrimary' : props.destructive ? 'glassDestructive' : 'glassQuiet'
      }
      compact={!props.primary}
      minHeight={spacing.rowMinHeight}
      disabled={props.disabled}
      onPress={props.onPress}
    />
  );
}

function GoalField(props: {
  label: string;
  testID: string;
  value: string;
  readonly: boolean;
  multiline?: boolean;
  onChange: (text: string) => void;
  onComposingChange?: (composing: boolean) => void;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ ...type.footnote, color: token('foreground') }}>{props.label}</Text>
      <Input
        testID={props.testID}
        accessibilityLabel={props.label}
        value={props.value}
        multiline={props.multiline}
        keyboardType={props.multiline ? 'default' : 'number-pad'}
        readonly={props.readonly}
        onChange={({ value }) => props.onChange(value)}
        onCompositionChange={({ composing }) => props.onComposingChange?.(composing)}
        style={{
          ...type.body,
          minHeight: props.multiline ? spacing.rowMinHeight * 2 : spacing.rowMinHeight,
          maxHeight: props.multiline ? spacing.rowMinHeight * 3 : undefined,
          minWidth: spacing.rowMinHeight,
          backgroundColor: token('surface'),
          color: token('foreground'),
          borderRadius: spacing.controlRadius,
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      />
    </View>
  );
}

function GoalHint(props: { children?: string | null; alert?: boolean }) {
  return (
    <Text
      style={{
        ...type.subheadline,
        color: token(props.alert ? 'glass-destructive' : 'foreground'),
      }}
    >
      {props.children}
    </Text>
  );
}

function GoalMetric(props: { label: string; value: string }) {
  return (
    <View
      style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}
    >
      <Text style={{ ...type.subheadlineMedium, color: token('foreground') }}>{props.label}</Text>
      <Text style={{ ...type.subheadline, color: token('foreground'), flexShrink: 1 }}>
        {props.value}
      </Text>
    </View>
  );
}

export function GoalContinuation(props: { objective: string }) {
  const label = () => tr('Continuing goal: {objective}', { objective: props.objective });
  return (
    <Text
      testID="goal-continuation"
      accessibilityLabel={label()}
      style={{
        ...type.footnote,
        color: token('glass-muted'),
        numberOfLines: 1,
        textOverflow: 'ellipsis',
      }}
    >
      {label()}
    </Text>
  );
}

export function ChatContextLabel(props: { subtitle: string; goal: AgentGoalDetail | null }) {
  const insets = safeAreaInsets();
  const candidate = computed(() => {
    const goal = props.goal;
    return goal && !goal.dismissed ? props.subtitle + ' · ' + goalStatus(goal.status) : null;
  });
  const width = () =>
    Math.max(
      0,
      windowSize().width -
        Math.max(spacing.pageX, insets().left) -
        Math.max(spacing.pageX, insets().right) -
        33, // Pill padding, status dot and gap.
    );
  const sample = computed(() => (candidate() ? JSON.stringify([candidate(), fontScale()]) : null));
  const measured = signal<{ key: string; width: number } | null>(null);
  const fits = () => {
    const size = measured();
    return size && size.key === sample() && Math.ceil(size.width) <= width();
  };
  return (
    <>
      <Each of={sample() ? [sample()!] : []} key={(key) => key}>
        {(key) => (
          // Measure before wrapping or truncating; a clipped line can report
          // the available width even when its full label does not fit.
          <View
            accessibilityElementsHidden
            style={{ position: 'absolute', opacity: 0, width: 'max-content' }}
            onLayout={({ bounds }) => {
              if (key() === sample()) measured.set({ key: key(), width: bounds.size.width });
            }}
          >
            <Text style={{ ...type.footnote, numberOfLines: 1 }}>{candidate()}</Text>
          </View>
        )}
      </Each>
      <Text
        testID="chat-context-label"
        style={{
          ...type.footnote,
          color: token('glass-muted'),
          minWidth: 0,
          flexShrink: 1,
          numberOfLines: 1,
          textOverflow: 'ellipsis',
        }}
      >
        {fits() ? candidate() : props.subtitle}
      </Text>
    </>
  );
}

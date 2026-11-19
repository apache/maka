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
  computed,
  effect,
  keymap,
  signal,
  Text,
  View,
  Scroll,
  platform,
} from 'nsh';
import type { ViewRef } from 'nsh';
import { DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import type { ComposerGoal } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { GoalStatus } from '../../../../packages/plugin-sdk/src/index.js';
import { formatDuration } from './duration';
import { tr, type MessageKey } from './locale';
import { SettingsEditor, SettingsField } from './SettingsField';
import { LoadingIndicator, LoadingState } from './Loading';
import { Icon } from './Icon';
import { C, compact, bodyTextStyle, captionTextStyle } from './ui';

export const goalStatusLabel = (status: GoalStatus): MessageKey =>
  (
    ({
      armed: 'Goal ready',
      active: 'Goal active',
      paused: 'Goal paused',
      blocked: 'Goal blocked',
      achieved: 'Goal achieved',
      cancelled: 'Goal cancelled',
      budget_limited: 'Goal budget reached',
    }) as const
  )[status];
export function GoalDialog(props: { goal: ComposerGoal; objective?: string; close(): void }) {
  const content = createGoalContent(props);
  return (
    <ModalDialog size="form" onCancel={props.close}>
      {content()}
    </ModalDialog>
  );
}

export function createGoalContent(props: {
  goal: ComposerGoal;
  objective?: string;
  close?: () => void;
}) {
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const objective = signal(props.objective ?? '');
  const budget = signal('');
  const editing = signal(false);
  const changingBudget = signal(false);
  const validation = signal(false);
  const resetEditing = () =>
    batch(() => {
      objective.set('');
      budget.set('');
      editing.set(false);
      changingBudget.set(false);
      validation.set(false);
    });
  const current = () => props.goal.view()?.current ?? null;
  let goalId = current()?.id ?? null;
  effect(() => {
    const next = current()?.id ?? null;
    if (next === goalId) return;
    goalId = next;
    resetEditing();
  });
  const creating = () => editing() || props.goal.view()?.current === null;
  const ended = () => current()?.status === 'achieved' || current()?.status === 'cancelled';
  const parsedBudget = () => (budget().trim() === '' ? null : Number(budget().trim()));
  const validBudget = () =>
    parsedBudget() === null || (Number.isSafeInteger(parsedBudget()) && parsedBudget()! > 0);
  const submit = async () => {
    validation.set(true);
    if (!objective().trim() || !validBudget() || props.goal.pending()) return;
    if ((await props.goal.create(objective().trim(), parsedBudget())) && alive) {
      resetEditing();
    }
  };
  const cancelEditing = () => {
    if (props.goal.pending()) return;
    if (!current() && props.close) props.close();
    else resetEditing();
  };
  const editBudget = () => {
    budget.set(current()?.tokenBudget?.toString() ?? '');
    changingBudget.set(!changingBudget());
    validation.set(false);
  };
  const applyBudget = async () => {
    validation.set(true);
    if (!validBudget()) return;
    if (
      (await props.goal.change(current()?.status === 'budget_limited' ? 'resume' : 'set_budget', {
        tokenBudget: parsedBudget(),
      })) &&
      alive
    ) {
      changingBudget.set(false);
      validation.set(false);
    }
  };
  const action = (label: MessageKey, run: () => void | Promise<unknown>, primary = false) => (
    <SettingsButton
      label={tr(label)}
      tone={primary ? 'primary' : label === 'Cancel editing' ? 'quiet' : undefined}
      disabled={props.goal.pending() || (label === 'Start Goal' && !objective().trim())}
      onPress={() => void run()}
    />
  );
  return () => {
    const root = signal<ViewRef | null>(null);
    // A snapshot of a running Goal arrives every second, and an Escape the
    // platform matches to a binding just replaced is lost.
    const cancellable = computed(() => creating() || changingBudget());
    effect(() => {
      const node = root();
      if (node && cancellable())
        return keymap.bind('escape', cancelEditing, { when: 'always', within: node });
    });
    return (
      <View ref={(node) => root.set(node)} style={{ minHeight: 0, flexShrink: 1, gap: 16 }}>
        <If when={!!props.close}>
          <DialogHeader title={tr(creating() ? 'New Goal' : 'Goal')} />
        </If>
        <Scroll style={{ flexShrink: 1, minHeight: 0 }}>
          <View style={{ gap: 16 }}>
            <If when={!props.goal.view()}>
              <LoadingState />
            </If>
            <If when={creating()}>
              <View
                style={{
                  gap: 8,
                  height: platform.idiom === 'terminal' ? 96 : compact() ? 120 : 160,
                }}
              >
                <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Objective')}</Text>
                <SettingsEditor
                  label={tr('Objective')}
                  placeholder={tr('What should the Agent accomplish?')}
                  value={objective()}
                  change={(value) => objective.set(value)}
                  autoFocus
                  disabled={props.goal.pending()}
                />
              </View>
            </If>
            <If when={!!current() && !creating()}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <If when={current()?.status === 'active'}>
                  <LoadingIndicator color={C.secondary} />
                </If>
                <If when={current()?.status !== 'active'}>
                  <Icon
                    name={
                      current()?.status === 'achieved'
                        ? 'statusSuccess'
                        : current()?.status === 'blocked'
                          ? 'statusUnknown'
                          : 'statusStopped'
                    }
                    color={C.secondary}
                  />
                </If>
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr(goalStatusLabel(current()!.status))} ·{' '}
                  {tr('Iteration {count}', { count: current()!.iterations })}
                </Text>
              </View>
              <Text style={{ ...bodyTextStyle, color: C.text }}>{current()!.objective}</Text>
              <If
                when={
                  current()?.status === 'active' &&
                  current()?.retryAt &&
                  current()!.retryAt! > Date.now()
                }
              >
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('Retrying at {time}', {
                    time: new Date(current()!.retryAt!).toLocaleString(),
                  })}
                </Text>
              </If>
              <If when={current()?.note}>
                <Text style={{ ...captionTextStyle, color: C.secondary }}>{current()!.note}</Text>
              </If>
              <View style={{ flexDirection: 'row', gap: 24, flexWrap: 'wrap' }}>
                <View style={{ gap: 4 }}>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Known tokens')}</Text>
                  <Text style={{ ...bodyTextStyle, color: C.text }}>
                    {current()!.consumed.missing ? '≥' : ''}
                    {current()!.consumed.known.toLocaleString()}
                  </Text>
                </View>
                <If when={current()?.tokenBudget !== null}>
                  <View style={{ gap: 4 }}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {tr('Remaining tokens')}
                    </Text>
                    <Text style={{ ...bodyTextStyle, color: C.text }}>
                      {current()!.remainingTokens?.toLocaleString() ?? tr('Usage incomplete')}
                    </Text>
                  </View>
                </If>
                <View style={{ gap: 4 }}>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Elapsed time')}</Text>
                  <Text style={{ ...bodyTextStyle, color: C.text }}>
                    {formatDuration(current()!.elapsedSeconds * 1000)}
                  </Text>
                </View>
              </View>
            </If>
            <If when={creating() || changingBudget()}>
              <View style={{ gap: 8 }}>
                <SettingsField
                  label={tr('Token budget (optional)')}
                  placeholder={tr('No limit')}
                  value={budget()}
                  change={(value) => budget.set(value)}
                  autoFocus={changingBudget() && !creating()}
                  disabled={props.goal.pending() || (!creating() && ended())}
                />
                <Text
                  style={{
                    ...captionTextStyle,
                    color: validation() && !validBudget() ? C.danger : C.muted,
                  }}
                >
                  {tr(
                    validation() && !validBudget()
                      ? 'Enter a positive whole number or leave the budget empty.'
                      : 'The budget is checked between turns; a running turn can exceed it.',
                  )}
                </Text>
              </View>
            </If>
            <If when={props.goal.error()}>
              <Text style={{ ...captionTextStyle, color: C.danger }}>{props.goal.error()}</Text>
            </If>
          </View>
        </Scroll>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <If when={props.goal.pending()}>
            <LoadingIndicator />
          </If>
          <If when={creating() || changingBudget()}>{action('Cancel editing', cancelEditing)}</If>
          <If when={creating()}>{action('Start Goal', submit, true)}</If>
          <If when={!!current() && !creating() && !changingBudget() && ended()}>
            {action('New Goal', () => {
              resetEditing();
              editing.set(true);
            })}
          </If>
          <If when={!!current() && !creating() && !ended()}>
            <If when={changingBudget()}>
              {action(
                current()?.status === 'budget_limited' ? 'Apply and resume' : 'Apply budget',
                applyBudget,
                true,
              )}
            </If>
            <If when={!changingBudget()}>
              {action('Change budget', editBudget)}
              {action('Cancel Goal', () => props.goal.change('cancel'))}
              <If when={!current()!.pending}>
                {action('Complete Goal', () => props.goal.change('complete'))}
              </If>
              <If when={current()!.status === 'active'}>
                {action('Pause Goal', () => props.goal.change('pause'), true)}
              </If>
              <If when={current()!.status !== 'active' && current()!.status !== 'budget_limited'}>
                {action('Resume Goal', () => props.goal.change('resume'), true)}
              </If>
            </If>
          </If>
          <If when={!!props.close && !creating() && !changingBudget()}>
            <SettingsButton
              label={tr('Close')}
              accessibilityLabel={tr('Close Goal')}
              onPress={() => props.close!()}
            />
          </If>
        </View>
      </View>
    );
  };
}

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
import { cleanup, signal, Text, View, Scroll, inputAction, platform } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import type { ComposerGoal } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { GoalStatus } from '../../../../packages/plugin-sdk/src/index.js';
import { tr, type MessageKey } from './locale';
import { SettingsEditor, SettingsField } from './SettingsField';
import { LoadingIndicator, LoadingState } from './Loading';
import { Icon } from './Icon';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  textTooltip,
} from './ui';

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
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const objective = signal(props.objective ?? '');
  const budget = signal('');
  const editing = signal(false);
  const changingBudget = signal(false);
  const validation = signal(false);
  const current = () => props.goal.view()?.current ?? null;
  const creating = () => editing() || props.goal.view()?.current === null;
  const ended = () => current()?.status === 'achieved' || current()?.status === 'cancelled';
  const parsedBudget = () => (budget().trim() === '' ? null : Number(budget().trim()));
  const validBudget = () =>
    parsedBudget() === null || (Number.isSafeInteger(parsedBudget()) && parsedBudget()! > 0);
  const submit = async () => {
    validation.set(true);
    if (!objective().trim() || !validBudget() || props.goal.pending()) return;
    if ((await props.goal.create(objective().trim(), parsedBudget())) && alive) {
      editing.set(false);
      objective.set('');
      budget.set('');
      validation.set(false);
    }
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
    <Button
      accessibilityLabel={tr(label)}
      disabled={props.goal.pending() || (label === 'Start Goal' && !objective().trim())}
      onPress={inputAction(run, null)}
      style={{
        ...controlStyle,
        ...(primary ? { backgroundColor: C.accent } : {}),
      }}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
      disabledStyle={controlDisabledStyle}
      activeStyle={{ backgroundColor: C.line }}
    >
      <Text style={{ color: primary ? C.background : C.text }}>{tr(label)}</Text>
    </Button>
  );
  return (
    <Dialog
      animation="none"
      onCancel={props.close}
      onOpenChange={({ open }) => {
        if (!open) props.close();
      }}
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        backgroundColor: C.scrim,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 640,
          maxHeight: '90%',
          minHeight: 0,
          backgroundColor: C.surface,
          borderRadius: 12,
          padding: 24,
          gap: 16,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <Text
            style={{
              ...bodyTextStyle,
              fontSize: 18,
              fontWeight: '600',
              color: C.text,
            }}
          >
            {tr(creating() ? 'New Goal' : 'Goal')}
          </Text>
          <Button
            accessibilityLabel={tr('Close Goal')}
            tooltip={textTooltip(() => tr('Close Goal'))}
            onPress={inputAction(props.close, null)}
            style={controlStyle}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
            activeStyle={{ backgroundColor: C.line }}
          >
            <Icon name="close" color={C.secondary} />
          </Button>
        </View>
        <Scroll style={{ flexShrink: 1, minHeight: 0 }}>
          <View style={{ gap: 16 }}>
            <If when={!props.goal.view()}>
              <LoadingState />
            </If>
            <If when={creating()}>
              <View style={{ gap: 8, height: platform.isTerminal ? 96 : 160 }}>
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
                    {Math.floor(current()!.elapsedSeconds / 60)}:
                    {String(current()!.elapsedSeconds % 60).padStart(2, '0')}
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
                  disabled={props.goal.pending()}
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
          <If when={creating()}>{action('Start Goal', submit, true)}</If>
          <If when={!!current() && !creating() && ended()}>
            {action('New Goal', () => {
              editing.set(true);
              budget.set('');
            })}
          </If>
          <If when={!!current() && !creating() && !ended()}>
            {action('Change budget', editBudget)}
            <If when={changingBudget()}>
              {action(
                current()?.status === 'budget_limited' ? 'Apply and resume' : 'Apply budget',
                applyBudget,
                true,
              )}
            </If>
            <If when={!changingBudget()}>
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
        </View>
      </View>
    </Dialog>
  );
}

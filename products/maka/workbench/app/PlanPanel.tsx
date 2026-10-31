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
import { computed, inputAction, platform, Scroll, Text, View } from 'nsh';
import type { ComposerPlan } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type {
  AgentPlanExecution,
  PlanArtifact,
  PlanProposal,
  PlanStepStatus,
} from '../../../../packages/plugin-sdk/src/index.js';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { InteractionAction } from './InteractionComposer';
import { tr } from './locale';
import { C, bodyTextStyle, captionTextStyle } from './ui';

const live = (execution: AgentPlanExecution | null) =>
  execution?.phase === 'awaiting_admission' || execution?.phase === 'active';

export function createPlanPanel(plan: ComposerPlan) {
  const proposal = computed((): PlanProposal | null => {
    const value = plan.view()?.current.proposal;
    return value?.status === 'pending_approval' || value?.status === 'revision_requested'
      ? value
      : null;
  });
  const execution = computed(() => plan.view()?.current.execution ?? null);
  // A running Plan comes first; otherwise a proposal waiting on the user does.
  const showing = computed((): 'proposal' | 'execution' | null =>
    live(execution()) ? 'execution' : proposal() ? 'proposal' : execution() ? 'execution' : null,
  );
  const artifact = (): PlanArtifact | null =>
    showing() === 'proposal'
      ? proposal()!.artifact
      : showing() === 'execution'
        ? execution()!.artifact
        : null;
  // A step the model left in progress is not running once the execution has stopped.
  const statusOf = (id: string): PlanStepStatus | null => {
    if (showing() !== 'execution') return null;
    const status = execution()!.steps.find((step) => step.id === id)?.status ?? 'pending';
    return status === 'in_progress' && !live(execution()) ? 'pending' : status;
  };
  const finished = () =>
    execution()?.steps.filter((step) => step.status === 'completed' || step.status === 'skipped')
      .length ?? 0;
  const phase = () => {
    const current = execution();
    if (!current) return '';
    if (current.cancellation && live(current))
      return tr('Cancellation requested; waiting for the original execution to stop.');
    switch (current.phase) {
      case 'awaiting_admission':
        return tr('Waiting to execute');
      case 'active': {
        const step = current.steps.find((item) => item.status === 'in_progress');
        const title = current.artifact.steps.find((item) => item.id === step?.id)?.title;
        return title ?? tr('Executing Plan');
      }
      case 'interrupted':
        return tr('Plan interrupted');
      case 'completed':
        return tr('Plan completed');
      case 'cancelled':
        return tr('Plan cancelled');
    }
  };
  return {
    shown: () => !!plan.error() || (!!plan.view()?.enabled && showing() !== null),
    /** Changes when a new proposal needs the user, so the panel opens for it. */
    attention: () =>
      proposal()?.status === 'pending_approval'
        ? `${proposal()!.id}/${proposal()!.revision}`
        : null,
    summary: () =>
      showing() === 'proposal'
        ? proposal()!.status === 'pending_approval'
          ? tr('Awaiting approval')
          : tr('Revision requested')
        : showing() === 'execution'
          ? `${finished()}/${execution()!.steps.length}`
          : '',
    preview: () =>
      plan.error() || (showing() === 'execution' ? phase() : (artifact()?.title ?? '')),
    problem: () =>
      !!plan.error() || (showing() === 'execution' && execution()!.phase === 'interrupted'),
    content: (previewed: () => boolean) => (
      <View style={{ minHeight: 0, flexShrink: 1 }}>
        <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              // Terminal rows are whole cells; spacing there comes from the rows themselves.
              gap: platform.isTerminal ? 0 : 8,
            }}
          >
            <Text
              style={[
                { ...bodyTextStyle, color: C.text, fontWeight: '600' },
                { userSelect: 'text' },
              ]}
            >
              {artifact()?.title ?? ''}
            </Text>
            <If when={artifact()?.overview}>
              <Text style={[{ ...bodyTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
                {artifact()!.overview!}
              </Text>
            </If>
            <Each of={artifact()?.steps ?? []} key={(step) => step.id}>
              {(step, index) => (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                  <View
                    style={{
                      height: bodyTextStyle.lineHeight,
                      minWidth: 16,
                      justifyContent: 'center',
                    }}
                  >
                    <If
                      when={statusOf(step().id) !== null}
                      else={
                        <Text
                          style={{ ...bodyTextStyle, color: C.muted }}
                        >{`${index() + 1}.`}</Text>
                      }
                    >
                      <If
                        when={statusOf(step().id) === 'in_progress'}
                        else={
                          <ChoiceIndicator
                            kind="checkbox"
                            checked={
                              statusOf(step().id) === 'completed' ||
                              statusOf(step().id) === 'skipped'
                            }
                          />
                        }
                      >
                        <Icon name="activity" color={C.accent} />
                      </If>
                    </If>
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: platform.isTerminal ? 0 : 2 }}>
                    <Text
                      style={[
                        {
                          ...bodyTextStyle,
                          color:
                            statusOf(step().id) === 'in_progress'
                              ? C.accent
                              : statusOf(step().id) === 'completed' ||
                                  statusOf(step().id) === 'skipped'
                                ? C.muted
                                : C.text,
                        },
                        { userSelect: 'text' },
                      ]}
                    >
                      {statusOf(step().id) === 'skipped'
                        ? tr('{title} (skipped)', { title: step().title })
                        : step().title}
                    </Text>
                    <If when={step().description}>
                      <Text
                        style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}
                      >
                        {step().description}
                      </Text>
                    </If>
                    <If when={step().files?.length}>
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.muted },
                          { numberOfLines: 2, userSelect: 'text' },
                        ]}
                      >
                        {step().files!.join(', ')}
                      </Text>
                    </If>
                  </View>
                </View>
              )}
            </Each>
            <If when={showing() === 'proposal' && artifact()?.risks?.length}>
              <View style={{ gap: 2 }}>
                <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Risks')}</Text>
                <Each of={artifact()?.risks ?? []} key={(_, index) => String(index)}>
                  {(risk) => (
                    <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}>
                      {`• ${risk()}`}
                    </Text>
                  )}
                </Each>
              </View>
            </If>
            {/* A running step is marked in the list; other phases are said here
                unless the tab's preview already says them. */}
            <If
              when={
                !previewed() &&
                showing() === 'execution' &&
                (execution()!.phase !== 'active' || !!execution()!.cancellation)
              }
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: execution()?.phase === 'interrupted' ? C.warning : C.muted,
                }}
              >
                {phase()}
              </Text>
            </If>
            <If
              when={
                showing() === 'execution' &&
                execution()?.phase === 'interrupted' &&
                execution()?.reason
              }
            >
              <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}>
                {execution()!.reason!}
              </Text>
            </If>
            <If
              when={
                showing() === 'proposal' &&
                proposal()?.status === 'revision_requested' &&
                plan.mode() === 'plan'
              }
            >
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Say what to change in a message, and a revised plan will follow.')}
              </Text>
            </If>
            <If when={plan.error()}>
              <Text style={[{ ...captionTextStyle, color: C.danger }, { userSelect: 'text' }]}>
                {plan.error()}
              </Text>
            </If>
          </View>
        </Scroll>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            paddingHorizontal: 16,
            paddingBottom: 8,
            flexShrink: 0,
          }}
        >
          <If when={showing() === 'proposal' && proposal()?.status === 'pending_approval'}>
            <InteractionAction
              primary
              label={tr('Approve and execute')}
              tooltip={tr(
                'Approve this exact Plan and allow the selected model to execute it with these workspace permissions. Model charges may apply.',
              )}
              disabled={plan.pending()}
              onPress={inputAction(plan.change, {
                kind: 'approve',
                proposalId: proposal()?.id ?? '',
                proposalRevision: proposal()?.revision ?? 0,
              })}
            />
          </If>
          <If
            when={
              showing() === 'proposal' &&
              (proposal()?.status === 'pending_approval' || plan.mode() !== 'plan')
            }
          >
            <InteractionAction
              label={tr('Request revision')}
              disabled={plan.pending()}
              onPress={inputAction(plan.change, {
                kind: 'revise',
                proposalId: proposal()?.id ?? '',
              })}
            />
          </If>
          <If when={showing() === 'proposal'}>
            <InteractionAction
              label={tr('Abandon proposal')}
              disabled={plan.pending()}
              onPress={inputAction(plan.change, {
                kind: 'abandon',
                proposalId: proposal()?.id ?? '',
              })}
            />
          </If>
          <If when={showing() === 'execution' && live(execution()) && !execution()?.cancellation}>
            <InteractionAction
              label={tr('Cancel Plan')}
              disabled={plan.pending()}
              onPress={inputAction(plan.change, {
                kind: 'cancel',
                executionId: execution()?.id ?? '',
              })}
            />
          </If>
          <If when={showing() === 'execution' && execution()?.phase === 'interrupted'}>
            <InteractionAction
              primary
              label={tr('Resume Plan')}
              disabled={plan.pending()}
              onPress={inputAction(plan.change, {
                kind: 'resume',
                executionId: execution()?.id ?? '',
              })}
            />
            <InteractionAction
              label={tr('Cancel Plan')}
              disabled={plan.pending()}
              onPress={inputAction(plan.change, {
                kind: 'cancel',
                executionId: execution()?.id ?? '',
              })}
            />
          </If>
        </View>
      </View>
    ),
  };
}

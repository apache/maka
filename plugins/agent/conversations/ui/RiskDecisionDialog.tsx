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

import { cleanup, inputAction, signal, Text, View, Scroll } from 'nsh';
import { Dialog } from 'nsh/base';
import type {
  AgentAdjudicateRisk,
  AgentExecution,
  AgentRunBlocker,
} from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import { SettingsField } from '../../../../products/maka/workbench/app/SettingsField';
import {
  SettingsButton,
  SettingsSegmented,
} from '../../../../products/maka/workbench/app/SettingsPage';
import { tr, type MessageKey } from '../../../../products/maka/workbench/app/locale';
import {
  createText,
  errorText,
  renderText,
  type UiText,
} from '../../../../products/maka/workbench/app/text';
import { C, bodyTextStyle, captionTextStyle } from '../../../../products/maka/workbench/app/ui';

export type RiskOffer = AgentRunBlocker['offeredActions'][number];
export type RiskActionKind = RiskOffer['kind'];
export type RiskReview = {
  source: AgentExecution;
  blockerId: AgentAdjudicateRisk['blockerId'];
  offer: RiskOffer;
};
export const riskActionLabels: Record<RiskActionKind, MessageKey> = {
  record_external_observation: 'Record external observation',
  authorize_replan: 'Authorize replanning',
  cancel_blocked_run: 'Cancel blocked run',
};

export function sameRiskOffer(a: RiskOffer, b: RiskOffer): boolean {
  if (a.kind !== b.kind) return false;
  const left = a.scope,
    right = b.scope;
  switch (left.kind) {
    case 'tool':
      return (
        right.kind === 'tool' &&
        left.tool.attempt === right.tool.attempt &&
        left.tool.call === right.tool.call
      );
    case 'model_replan':
      return (
        right.kind === 'model_replan' &&
        left.attempt === right.attempt &&
        left.base_step === right.base_step
      );
    case 'run_cancellation':
      return right.kind === 'run_cancellation';
  }
}
function riskScopeText(scope: RiskOffer['scope']): UiText {
  switch (scope.kind) {
    case 'tool':
      return {
        key: 'Original tool call {call} in model attempt {attempt}',
        values: { call: scope.tool.call, attempt: scope.tool.attempt },
      };
    case 'model_replan':
      return {
        key: 'Model attempt {attempt}, based on step {step}',
        values: { attempt: scope.attempt, step: scope.base_step },
      };
    case 'run_cancellation':
      return { key: 'Entire run' };
  }
}

export function RiskDecisionDialog(props: {
  review: RiskReview;
  /** Rechecks the original basis and the backend offer, never advances consent. */
  current(): boolean;
  unavailable(): UiText | undefined;
  pending(): boolean;
  submit(input: AgentAdjudicateRisk): Promise<void>;
  close(): void;
}) {
  // Consent belongs to this captured basis even if a later execution arrives.
  const review = props.review;
  const draft = signal('');
  const format = signal<'text' | 'json'>('text');
  const submitting = signal(false);
  const error = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const busy = () => submitting() || props.pending();
  const positive = () => review.offer.kind !== 'cancel_blocked_run';
  const close = () => {
    if (alive && !submitting()) props.close();
  };
  const submit = async (input: { text: string; format: 'text' | 'json' }) => {
    if (
      !alive ||
      busy() ||
      !props.current() ||
      props.unavailable() !== undefined ||
      !input.text.trim()
    )
      return;
    let decision: AgentAdjudicateRisk['decision'];
    if (review.offer.kind === 'cancel_blocked_run') {
      decision = { kind: 'cancel_blocked_run', diagnostic: input.text };
    } else {
      let evidence: Extract<
        AgentAdjudicateRisk['decision'],
        { kind: 'authorize_replan' }
      >['evidence'];
      if (input.format === 'json') {
        try {
          const value = JSON.parse(input.text, (_key, value) => {
            if (typeof value === 'number' && !Number.isFinite(value))
              throw new Error('nonfinite JSON number');
            return value;
          });
          evidence = { kind: 'json', value };
        } catch {
          error.set({ key: 'Enter valid JSON evidence.' });
          return;
        }
      } else evidence = { kind: 'text', text: input.text };
      decision = { kind: review.offer.kind, evidence };
    }
    submitting.set(true);
    error.set('');
    try {
      await props.submit({
        sessionId: review.source.sessionId,
        runId: review.source.runId,
        expectedHighWater: review.source.highWater,
        blockerId: review.blockerId,
        decision,
      });
      if (alive) props.close();
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    } finally {
      if (alive) submitting.set(false);
    }
  };
  return (
    <Dialog
      animation="none"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      closeOnSwipe={false}
      onCancel={close}
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
        backgroundColor: C.scrim,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 720,
          height: '100%',
          maxHeight: 640,
          minHeight: 0,
          padding: 16,
          gap: 12,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 12,
        }}
      >
        <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
          {tr(riskActionLabels[review.offer.kind])}
        </Text>
        <Scroll style={{ flex: 1, minHeight: 0 }}>
          <View style={{ gap: 12 }}>
            <Text style={{ ...bodyTextStyle, color: C.text }}>
              {renderText(riskScopeText(review.offer.scope))}
            </Text>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Run {run} · blocker {blocker} · observation {revision}', {
                run: review.source.runId,
                blocker: review.blockerId,
                revision: review.source.highWater,
              })}
            </Text>
            <If when={review.offer.kind === 'authorize_replan'}>
              <Text style={{ ...bodyTextStyle, color: C.warning }}>
                {tr(
                  'Allow replanning within the shown scope and current permissions. This does not authorize replaying the original unknown operation or waive pending cleanup.',
                )}
              </Text>
            </If>
            <If when={review.offer.kind === 'cancel_blocked_run'}>
              <Text style={{ ...bodyTextStyle, color: C.warning }}>
                {tr(
                  'Request cancellation of this run. Previously admitted operations may still finish, and cleanup must still be confirmed.',
                )}
              </Text>
            </If>
            <If when={positive()}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr(
                  'Your evidence is a human report, not a provider receipt or proof that the original operation settled.',
                )}
              </Text>
              <SettingsSegmented
                label={tr('Evidence format')}
                value={format()}
                choices={[
                  { value: 'text', title: tr('Text') },
                  { value: 'json', title: 'JSON' },
                ]}
                disabled={busy()}
                change={(value) => {
                  if (value === 'text' || value === 'json') {
                    format.set(value);
                    error.set('');
                  }
                }}
              />
            </If>
            <SettingsField
              multiline
              label={positive() ? tr('Evidence') : tr('Reason for cancelling')}
              value={draft()}
              change={(value) => {
                draft.set(value);
                error.set('');
              }}
              disabled={busy()}
              autoFocus
            />
            <If when={!props.current() && !submitting()}>
              <Text style={{ ...captionTextStyle, color: C.warning }}>
                {tr('This run changed. Close this decision and review the current state.')}
              </Text>
            </If>
            <If when={props.unavailable()}>
              {(reason) => (
                <Text style={{ ...captionTextStyle, color: C.warning }}>
                  {renderText(reason())}
                </Text>
              )}
            </If>
            <If when={props.pending()}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Checking the original decision receipt. Do not submit another decision.')}
              </Text>
            </If>
          </View>
        </Scroll>
        <If when={error()}>
          <Text style={{ ...bodyTextStyle, color: C.danger }}>{error()}</Text>
        </If>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <SettingsButton
            label={tr('Close')}
            tone="quiet"
            disabled={submitting()}
            onPress={inputAction(close, null)}
          />
          <SettingsButton
            label={
              submitting() ? tr('Submitting decision…') : tr(riskActionLabels[review.offer.kind])
            }
            tone={positive() ? 'primary' : 'danger'}
            disabled={
              busy() || !props.current() || props.unavailable() !== undefined || !draft().trim()
            }
            onPress={inputAction(submit, { text: draft(), format: format() })}
          />
        </View>
      </View>
    </Dialog>
  );
}

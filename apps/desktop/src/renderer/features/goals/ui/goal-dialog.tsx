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

/**
 * The form behind the composer menu's "Set a goal…" entry.
 *
 * A Goal is the one control here that keeps spending tokens after the user
 * stops typing, so it is a dialog rather than a menu row: the condition needs
 * a sentence, and the two budgets that stop it should be visible while it is
 * being armed, not discovered afterwards.
 *
 * Bounds are the Host's. This sends what the user chose and reports what the
 * Host answers; it does not clamp a rejected number into an accepted one,
 * because the Goal that then runs would not be the one they asked for.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  GOAL_CONDITION_TEXT_LIMIT,
  GOAL_MAX_ITERATIONS_LIMIT,
  GOAL_TOKEN_BUDGET_MINIMUM,
} from '@maka/core/goal';
import { useUiLocale } from '@maka/ui';
import {
  getShellCopy,
  localizedShellErrorMessage,
} from '../../../locales/shell-copy.js';
import {
  interpretGoalArmOutcome,
  type GoalArmReconciliationNotice,
} from '../model/goal-arm-outcome.js';
import { readGoalBudget } from '../model/goal-budget.js';
import type { GoalArmInput, GoalArmOutcome } from '../ports.js';

export interface GoalDialogProps {
  /** The Session to arm. `undefined` closes the dialog. */
  sessionId?: string;
  onArm(sessionId: string, request: GoalArmInput): Promise<GoalArmOutcome>;
  onClose(): void;
}

export function GoalDialog(props: GoalDialogProps) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).goalDialog;
  const [condition, setCondition] = useState('');
  const [maxIterationsText, setMaxIterationsText] = useState('');
  const [tokenBudgetText, setTokenBudgetText] = useState('');
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string>();
  const [reconciliation, setReconciliation] =
    useState<GoalArmReconciliationNotice>();
  const armGenerationRef = useRef(0);

  // Each opening starts from empty: the previous Session's condition is not a
  // useful default for this one, and a stale error would outlive its cause.
  useLayoutEffect(() => {
    armGenerationRef.current += 1;
    if (props.sessionId === undefined) return;
    setCondition('');
    setMaxIterationsText('');
    setTokenBudgetText('');
    setError(undefined);
    setArming(false);
    setReconciliation(undefined);
  }, [props.sessionId]);

  const sessionId = props.sessionId;
  const maxIterations = readGoalBudget(
    maxIterationsText,
    1,
    GOAL_MAX_ITERATIONS_LIMIT,
  );
  const tokenBudget = readGoalBudget(
    tokenBudgetText,
    GOAL_TOKEN_BUDGET_MINIMUM,
  );
  const locked = reconciliation !== undefined;
  const canSubmit =
    condition.trim().length > 0 &&
    maxIterations.kind !== 'invalid' &&
    tokenBudget.kind !== 'invalid' &&
    !arming &&
    !locked;

  const reconciliationMessage = (() => {
    if (!reconciliation) return undefined;
    switch (reconciliation.kind) {
      case 'matching_goal':
        return copy.reconciledMatching(
          reconciliation.goal.condition,
          copy.statusLabels[reconciliation.goal.status],
        );
      case 'different_goal':
        return copy.reconciledDifferent(
          reconciliation.goal.condition,
          copy.statusLabels[reconciliation.goal.status],
        );
      case 'no_goal':
        return copy.reconciledNoGoal;
      case 'unavailable':
        return copy.reconciliationUnavailable;
    }
  })();

  async function arm(): Promise<void> {
    if (!sessionId || !canSubmit) return;
    const armGeneration = ++armGenerationRef.current;
    setArming(true);
    setError(undefined);
    try {
      const outcome = await props.onArm(sessionId, {
        condition: condition.trim(),
        maxIterations:
          maxIterations.kind === 'value' ? maxIterations.value : null,
        tokenBudget: tokenBudget.kind === 'value' ? tokenBudget.value : null,
      });
      if (armGenerationRef.current !== armGeneration) return;
      const action = interpretGoalArmOutcome(outcome);
      if (action.action === 'close') {
        props.onClose();
      } else {
        setReconciliation(action.notice);
      }
    } catch (cause) {
      if (armGenerationRef.current !== armGeneration) return;
      setError(localizedShellErrorMessage(cause, copy.failedFallback, locale));
    } finally {
      if (armGenerationRef.current === armGeneration) setArming(false);
    }
  }

  return (
    <Dialog
      isOpen={sessionId !== undefined}
      onOpenChange={(open) => {
        if (!open && !arming) props.onClose();
      }}
      purpose="form"
      width={520}
      className="goalDialog"
    >
      <Layout
        header={
          <DialogHeader
            title={copy.title}
            onOpenChange={(open) => {
              if (!open && !arming) props.onClose();
            }}
          />
        }
        content={
          <LayoutContent padding={4}>
            <VStack gap={4}>
              <Text type="body" color="secondary">
                {copy.description}
              </Text>
              {reconciliationMessage ? (
                <Text type="body" color="secondary">
                  {reconciliationMessage}
                </Text>
              ) : null}
              <TextArea
                label={copy.conditionLabel}
                description={copy.conditionDescription}
                placeholder={copy.conditionPlaceholder}
                value={condition}
                onChange={setCondition}
                rows={3}
                maxLength={GOAL_CONDITION_TEXT_LIMIT.codeUnits}
                isRequired
                isDisabled={arming || locked}
                hasAutoFocus
                {...(error
                  ? { status: { type: 'error' as const, message: error } }
                  : {})}
              />
              <HStack gap={3}>
                <TextInput
                  label={copy.maxIterationsLabel}
                  description={copy.maxIterationsDescription}
                  value={maxIterationsText}
                  onChange={setMaxIterationsText}
                  isOptional
                  isDisabled={arming || locked}
                  {...(maxIterations.kind === 'invalid'
                    ? {
                        status: {
                          type: 'error' as const,
                          message: copy.maxIterationsInvalid(
                            GOAL_MAX_ITERATIONS_LIMIT,
                          ),
                        },
                      }
                    : {})}
                />
                <TextInput
                  label={copy.tokenBudgetLabel}
                  description={copy.tokenBudgetDescription}
                  value={tokenBudgetText}
                  onChange={setTokenBudgetText}
                  isOptional
                  isDisabled={arming || locked}
                  {...(tokenBudget.kind === 'invalid'
                    ? {
                        status: {
                          type: 'error' as const,
                          message: copy.tokenBudgetInvalid(
                            GOAL_TOKEN_BUDGET_MINIMUM,
                          ),
                        },
                      }
                    : {})}
                />
              </HStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button
                variant="ghost"
                label={locked ? copy.close : copy.cancel}
                isDisabled={arming}
                onClick={props.onClose}
              />
              <Button
                variant="primary"
                label={copy.submit}
                isDisabled={!canSubmit}
                isLoading={arming}
                onClick={() => void arm()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

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
 * The form behind the ＋ menu's "Set a goal…" entry.
 *
 * A Goal is the one control here that keeps spending tokens after the user
 * stops typing, so it is a dialog rather than a menu row: the condition needs
 * a sentence, and the two budgets that stop it should be visible while it is
 * being armed, not discovered afterwards.
 *
 * Bounds are the Host's. This sends what the user chose and reports what the
 * Host answers; it does not clamp a rejected number into an accepted one,
 * because the Goal that then runs would not be the one they asked for. For the
 * same reason the budget fields hold the user's own text rather than a parsed
 * number: a field that quietly keeps the last value it could parse can arm a
 * budget the form is no longer showing, and a field that quietly keeps nothing
 * can arm no budget at all where the user asked for a tight one.
 */
import { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useUiLocale } from '@maka/ui';
import {
  GOAL_CONDITION_TEXT_LIMIT,
  GOAL_MAX_ITERATIONS_LIMIT,
  GOAL_TOKEN_BUDGET_MINIMUM,
} from '@maka/core/goal';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

type BudgetReading =
  | { readonly kind: 'empty' }
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'invalid' };

/**
 * Read one budget field, refusing anything the Host would not take.
 *
 * `min`/`max` repeat the operation's own bounds so the refusal can be shown
 * beside the field instead of arriving as a rejected frame; the numbers
 * themselves come from the shared Goal limits, so there is still one authority
 * for what they are.
 */
function readGoalBudget(text: string, min: number, max?: number): BudgetReading {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };
  if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min) return { kind: 'invalid' };
  if (max !== undefined && value > max) return { kind: 'invalid' };
  return { kind: 'value', value };
}

export function GoalDialog(props: {
  /** The Session to arm. `undefined` closes the dialog. */
  sessionId?: string;
  onClose(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).goalDialog;
  const [condition, setCondition] = useState('');
  const [maxIterationsText, setMaxIterationsText] = useState('');
  const [tokenBudgetText, setTokenBudgetText] = useState('');
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string>();

  // Each opening starts from empty: the previous Session's condition is not a
  // useful default for this one, and a stale error would outlive its cause.
  useEffect(() => {
    if (props.sessionId === undefined) return;
    setCondition('');
    setMaxIterationsText('');
    setTokenBudgetText('');
    setError(undefined);
    setArming(false);
  }, [props.sessionId]);

  const sessionId = props.sessionId;
  const maxIterations = readGoalBudget(maxIterationsText, 1, GOAL_MAX_ITERATIONS_LIMIT);
  const tokenBudget = readGoalBudget(tokenBudgetText, GOAL_TOKEN_BUDGET_MINIMUM);
  const canSubmit =
    condition.trim().length > 0 &&
    maxIterations.kind !== 'invalid' &&
    tokenBudget.kind !== 'invalid' &&
    !arming;

  async function arm(): Promise<void> {
    if (!sessionId || !canSubmit) return;
    setArming(true);
    setError(undefined);
    try {
      await window.maka.goal.arm(sessionId, {
        condition: condition.trim(),
        maxIterations: maxIterations.kind === 'value' ? maxIterations.value : null,
        tokenBudget: tokenBudget.kind === 'value' ? tokenBudget.value : null,
      });
      props.onClose();
    } catch (cause) {
      setError(localizedShellErrorMessage(cause, copy.failedFallback, locale));
    } finally {
      setArming(false);
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
        header={<DialogHeader title={copy.title} onOpenChange={(open) => {
          if (!open && !arming) props.onClose();
        }} />}
        content={
          <LayoutContent padding={4}>
            <VStack gap={4}>
              <Text type="body" color="secondary">{copy.description}</Text>
              <TextArea
                label={copy.conditionLabel}
                description={copy.conditionDescription}
                placeholder={copy.conditionPlaceholder}
                value={condition}
                onChange={setCondition}
                rows={3}
                maxLength={GOAL_CONDITION_TEXT_LIMIT.codeUnits}
                isRequired
                isDisabled={arming}
                hasAutoFocus
                {...(error ? { status: { type: 'error' as const, message: error } } : {})}
              />
              <HStack gap={3}>
                <TextInput
                  label={copy.maxIterationsLabel}
                  description={copy.maxIterationsDescription}
                  value={maxIterationsText}
                  onChange={setMaxIterationsText}
                  isOptional
                  isDisabled={arming}
                  {...(maxIterations.kind === 'invalid'
                    ? { status: { type: 'error' as const, message: copy.maxIterationsInvalid(GOAL_MAX_ITERATIONS_LIMIT) } }
                    : {})}
                />
                <TextInput
                  label={copy.tokenBudgetLabel}
                  description={copy.tokenBudgetDescription}
                  value={tokenBudgetText}
                  onChange={setTokenBudgetText}
                  isOptional
                  isDisabled={arming}
                  {...(tokenBudget.kind === 'invalid'
                    ? { status: { type: 'error' as const, message: copy.tokenBudgetInvalid(GOAL_TOKEN_BUDGET_MINIMUM) } }
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
                label={copy.cancel}
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

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
 * because the Goal that then runs would not be the one they asked for.
 */
import { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { useUiLocale } from '@maka/ui';
import {
  GOAL_CONDITION_TEXT_LIMIT,
  GOAL_MAX_ITERATIONS_LIMIT,
  GOAL_TOKEN_BUDGET_MINIMUM,
} from '@maka/core/goal';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';

export function GoalDialog(props: {
  /** The Session to arm. `undefined` closes the dialog. */
  sessionId?: string;
  onClose(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).goalDialog;
  const [condition, setCondition] = useState('');
  const [maxIterations, setMaxIterations] = useState<number | null>(null);
  const [tokenBudget, setTokenBudget] = useState<number | null>(null);
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string>();

  // Each opening starts from empty: the previous Session's condition is not a
  // useful default for this one, and a stale error would outlive its cause.
  useEffect(() => {
    if (props.sessionId === undefined) return;
    setCondition('');
    setMaxIterations(null);
    setTokenBudget(null);
    setError(undefined);
    setArming(false);
  }, [props.sessionId]);

  const sessionId = props.sessionId;
  const canSubmit = condition.trim().length > 0 && !arming;

  async function arm(): Promise<void> {
    if (!sessionId || !canSubmit) return;
    setArming(true);
    setError(undefined);
    try {
      await window.maka.goal.arm(sessionId, {
        condition: condition.trim(),
        maxIterations,
        tokenBudget,
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
                <NumberInput
                  label={copy.maxIterationsLabel}
                  description={copy.maxIterationsDescription}
                  value={maxIterations}
                  onChange={setMaxIterations}
                  min={1}
                  max={GOAL_MAX_ITERATIONS_LIMIT}
                  isOptional
                  isDisabled={arming}
                />
                <NumberInput
                  label={copy.tokenBudgetLabel}
                  description={copy.tokenBudgetDescription}
                  value={tokenBudget}
                  onChange={setTokenBudget}
                  min={GOAL_TOKEN_BUDGET_MINIMUM}
                  step={1_000}
                  isOptional
                  isDisabled={arming}
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

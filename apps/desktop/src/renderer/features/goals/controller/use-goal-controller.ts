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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useUiLocale, type ChatView } from '@maka/ui';
import {
  getShellCopy,
  localizedShellErrorMessage,
} from '../../../locales/shell-copy.js';
import { isLiveGoal, type LiveGoalState } from '../model/live-goal.js';
import type { GoalArmInput, GoalArmOutcome } from '../ports.js';
import { useGoalServices } from '../services-context.js';
import type { GoalHostModel } from '../ui/goal-host.js';

type GoalIndicator = NonNullable<
  ComponentProps<typeof ChatView>['goalIndicator']
>;

export interface GoalControllerCommands {
  /** Opens for the current Session and snapshots that id until close. */
  openDialog(): void;
}

export interface GoalControllerSelectors {
  active: boolean;
  indicator?: GoalIndicator;
}

export interface UseGoalControllerInput {
  activeSessionId: string | undefined;
  reportError(sessionId: string, title: string, description?: string): void;
}

export interface GoalController {
  host: GoalHostModel;
  commands: GoalControllerCommands;
  selectors: GoalControllerSelectors;
}

/** Owns all renderer Goal state, controls, subscriptions, and dialog lifecycle. */
export function useGoalController(
  input: UseGoalControllerInput,
): GoalController {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).app;
  const { goal: service } = useGoalServices();
  const [activeGoal, setActiveGoal] = useState<LiveGoalState | null>(null);
  const [dialogSessionId, setDialogSessionId] = useState<string>();
  const pendingControlSessionIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const sessionId = input.activeSessionId;
    if (!sessionId) {
      setActiveGoal(null);
      return;
    }

    setActiveGoal(null);
    let disposed = false;
    let refreshSequence = 0;
    const refresh = (): void => {
      const sequence = ++refreshSequence;
      void service
        .get(sessionId)
        .then((goal) => {
          if (disposed || sequence !== refreshSequence) return;
          setActiveGoal(goal && isLiveGoal(goal) ? goal : null);
        })
        .catch(() => {
          if (!disposed && sequence === refreshSequence) setActiveGoal(null);
        });
    };

    refresh();
    const unsubscribe = service.subscribeChanges((changedSessionId) => {
      if (!changedSessionId || changedSessionId === sessionId) refresh();
    });
    return () => {
      disposed = true;
      refreshSequence += 1;
      unsubscribe();
    };
  }, [input.activeSessionId, service]);

  const reportControlFailure = useCallback(
    (
      sessionId: string,
      error: unknown,
      title: string,
      fallback: string,
    ): void => {
      input.reportError(
        sessionId,
        title,
        localizedShellErrorMessage(error, fallback, locale),
      );
    },
    [input.reportError, locale],
  );

  const runExclusiveControl = useCallback(
    (
      sessionId: string,
      operation: () => Promise<void>,
      reportFailure: (error: unknown) => void,
    ): void => {
      const pending = pendingControlSessionIdsRef.current;
      if (pending.has(sessionId)) return;
      pending.add(sessionId);
      void operation()
        .catch(reportFailure)
        .finally(() => pending.delete(sessionId));
    },
    [],
  );

  const indicator = useMemo<GoalIndicator | undefined>(() => {
    if (!activeGoal) return undefined;
    const common = {
      condition: activeGoal.condition,
      iterations: activeGoal.iterations,
      maxIterations: activeGoal.maxIterations,
      setAt: activeGoal.setAt,
      tokensSpent: activeGoal.tokensNow,
      ...(activeGoal.tokenBudget !== undefined
        ? { tokenBudget: activeGoal.tokenBudget }
        : {}),
      onClear: () => {
        void service.clear(activeGoal.sessionId).catch((error) => {
          reportControlFailure(
            activeGoal.sessionId,
            error,
            copy.goalClearFailedTitle,
            copy.goalClearFailedFallback,
          );
        });
      },
    };

    if (activeGoal.status === 'paused') {
      return {
        ...common,
        status: 'paused',
        pausedAt: activeGoal.pausedAt,
        onResume: () => {
          runExclusiveControl(
            activeGoal.sessionId,
            () => service.resume(activeGoal.sessionId),
            (error) => {
              reportControlFailure(
                activeGoal.sessionId,
                error,
                copy.goalResumeFailedTitle,
                copy.goalResumeFailedFallback,
              );
            },
          );
        },
      };
    }

    return {
      ...common,
      status: activeGoal.status,
      onPause: () => {
        runExclusiveControl(
          activeGoal.sessionId,
          () => service.pause(activeGoal.sessionId),
          (error) => {
            reportControlFailure(
              activeGoal.sessionId,
              error,
              copy.goalPauseFailedTitle,
              copy.goalPauseFailedFallback,
            );
          },
        );
      },
    };
  }, [
    activeGoal,
    copy.goalClearFailedFallback,
    copy.goalClearFailedTitle,
    copy.goalPauseFailedFallback,
    copy.goalPauseFailedTitle,
    copy.goalResumeFailedFallback,
    copy.goalResumeFailedTitle,
    reportControlFailure,
    runExclusiveControl,
    service,
  ]);

  const openDialog = useCallback(() => {
    if (input.activeSessionId) setDialogSessionId(input.activeSessionId);
  }, [input.activeSessionId]);
  const closeDialog = useCallback(() => setDialogSessionId(undefined), []);
  const arm = useCallback(
    (sessionId: string, request: GoalArmInput): Promise<GoalArmOutcome> =>
      service.arm(sessionId, request),
    [service],
  );

  return useMemo(
    () => ({
      host: {
        ...(dialogSessionId ? { dialogSessionId } : {}),
        arm,
        closeDialog,
      },
      commands: { openDialog },
      selectors: {
        active: activeGoal !== null,
        ...(indicator ? { indicator } : {}),
      },
    }),
    [activeGoal, arm, closeDialog, dialogSessionId, indicator, openDialog],
  );
}

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
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  ChatViewGoalProjectionProvider,
  ComposerGoalProjectionProvider,
  type ChatViewGoalProjection,
  type ComposerGoalProjection,
} from '@maka/ui';
import {
  useGoalController,
  type UseGoalControllerInput,
} from '../controller/use-goal-controller.js';
import type { GoalHostModel } from './goal-host.js';

const GoalHostContext = createContext<GoalHostModel | null>(null);

export interface GoalProviderProps extends UseGoalControllerInput {
  readonly canOpenDialog: boolean;
  readonly children?: ReactNode;
}

/**
 * Owns the Goal controller below AppShell and publishes only reader-local data.
 *
 * Controller updates re-render this provider and the matching narrow UI
 * context reader. `children` is the element AppShell already built, so React
 * can retain the unrelated frame instead of widening Goal state back to the
 * renderer root.
 */
export function GoalProvider({
  activeSessionId,
  canOpenDialog,
  reportError: reportErrorInput,
  children,
}: GoalProviderProps) {
  const reportErrorRef = useRef(reportErrorInput);
  useLayoutEffect(() => {
    reportErrorRef.current = reportErrorInput;
  }, [reportErrorInput]);
  const reportError = useCallback<UseGoalControllerInput['reportError']>(
    (...args) => reportErrorRef.current(...args),
    [],
  );
  const controller = useGoalController({ activeSessionId, reportError });

  const composer = useMemo<ComposerGoalProjection>(
    () => ({
      goalActive: controller.selectors.active,
      onSetGoal:
        canOpenDialog && activeSessionId
          ? controller.commands.openDialog
          : undefined,
    }),
    [
      activeSessionId,
      canOpenDialog,
      controller.commands.openDialog,
      controller.selectors.active,
    ],
  );
  const indicator = useMemo<ChatViewGoalProjection>(
    () => ({ goalIndicator: controller.selectors.indicator }),
    [controller.selectors.indicator],
  );
  const host = useMemo<GoalHostModel>(
    () => ({
      ...(controller.host.dialogSessionId
        ? { dialogSessionId: controller.host.dialogSessionId }
        : {}),
      arm: controller.host.arm,
      closeDialog: controller.host.closeDialog,
    }),
    [
      controller.host.arm,
      controller.host.closeDialog,
      controller.host.dialogSessionId,
    ],
  );

  return (
    <ComposerGoalProjectionProvider value={composer}>
      <ChatViewGoalProjectionProvider value={indicator}>
        <GoalHostContext.Provider value={host}>
          {children}
        </GoalHostContext.Provider>
      </ChatViewGoalProjectionProvider>
    </ComposerGoalProjectionProvider>
  );
}

export function useGoalHostModel(): GoalHostModel {
  const model = useContext(GoalHostContext);
  if (!model) throw new Error('GoalProvider is missing');
  return model;
}

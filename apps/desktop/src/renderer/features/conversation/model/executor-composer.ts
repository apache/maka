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

import type { ComposerProps } from '@maka/ui';
import type { useExecutorSelection } from '../controller/use-executor-selection.js';

export function executorComposerProps(
  executor: ReturnType<typeof useExecutorSelection>,
  input: {
    activeId: string | undefined;
    turnActive: boolean;
    taskSubmissionHardBlocked: boolean;
    connectionCount: number;
    onSetup(): void;
    onNewTask(): void;
  },
): Pick<ComposerProps, 'executorPicker' | 'sendBlocked' | 'noModelConnection'> {
  const fixed = !!input.activeId;
  return {
    executorPicker:
      !fixed || executor.selection
        ? {
            catalog: executor.catalog,
            selection: executor.selection,
            fixed,
            disabled: executor.changing || (fixed && input.turnActive),
            loading: executor.loading,
            error: executor.error,
            onSelect: (selection) => executor.select(selection),
            onRetry: () => {
              void executor.refresh();
            },
            onSetup: input.onSetup,
            onNewTask: input.onNewTask,
          }
        : undefined,
    noModelConnection: !executor.selection && !fixed && input.connectionCount === 0,
    sendBlocked:
      input.taskSubmissionHardBlocked ||
      !!(
        executor.selection &&
        (executor.entry?.readiness !== 'ready' || (fixed && input.turnActive))
      ),
  };
}

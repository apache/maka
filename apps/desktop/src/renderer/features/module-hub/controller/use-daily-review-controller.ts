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

import { useEffect, useMemo, useState } from 'react';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import {
  dailyReviewRangeBounds,
  projectDailyReviewView,
  type DailyReviewProjectionBridge,
} from '@maka/ui';
import type { ModuleHubServices } from '../ports.js';
import {
  isDefaultRuntimeHostCurrent,
  runOnDefaultRuntimeHost,
} from './default-runtime-host.js';

export interface DailyReviewController {
  readonly bridge: DailyReviewProjectionBridge;
  readonly revision: number;
  readonly task?: ScheduledTask;
}

function isDailyReviewTask(task: ScheduledTask): boolean {
  return task.id === 'system-daily-review' || task.presetId === 'daily-review';
}

export function useDailyReviewController(input: {
  readonly services: ModuleHubServices;
  readonly tasks: readonly ScheduledTask[];
}): DailyReviewController {
  const [revision, setRevision] = useState(0);
  const task = input.tasks.find(isDailyReviewTask);

  useEffect(() => {
    const invalidate = () => setRevision((value) => value + 1);
    const unsubscribeSessions = input.services.dailyReview.subscribeChanges(invalidate);
    const unsubscribeHosts = input.services.runtimeHosts.subscribeChanges(invalidate);
    return () => {
      unsubscribeSessions();
      unsubscribeHosts();
    };
  }, [input.services]);

  const bridge = useMemo<DailyReviewProjectionBridge>(() => ({
    async load(range, offsetDays = 0) {
      const bounds = dailyReviewRangeBounds(range, Date.now(), offsetDays);
      const result = await runOnDefaultRuntimeHost(
        input.services.runtimeHosts,
        async (host) => {
          const [sessions, usage] = await Promise.all([
            input.services.dailyReview.listSessions(host),
            input.services.dailyReview.readUsage(bounds, host),
          ]);
          return { sessions, usage };
        },
      );
      if (!(await isDefaultRuntimeHostCurrent(input.services.runtimeHosts, result.host))) {
        throw new Error('The default Runtime Host changed while loading Daily Review');
      }
      return projectDailyReviewView({
        task: input.tasks.find(isDailyReviewTask),
        sessions: result.value.sessions,
        usage: result.value.usage,
        ...bounds,
      });
    },
  }), [input.services, input.tasks]);

  return { bridge, revision, task };
}

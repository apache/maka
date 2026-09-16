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

import type { SessionSummary } from '@maka/core/session';

export interface SessionListRefresher<T extends SessionSummary = SessionSummary> {
  refresh(): Promise<T[]>;
}

export interface SessionListRefresherOptions<T extends SessionSummary> {
  listSessions: () => Promise<T[]>;
  currentSessions: () => T[];
  commitSessions: (sessions: T[]) => void;
  onError: (error: unknown) => void;
}

export function createSessionListRefresher<T extends SessionSummary>(
  options: SessionListRefresherOptions<T>,
): SessionListRefresher<T> {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let activeRefresh: Promise<T[]> | undefined;

  const drainRefreshes = async (): Promise<T[]> => {
    try {
      let result = options.currentSessions();
      while (completedGeneration < requestedGeneration) {
        const generation = requestedGeneration;
        try {
          const listed = await options.listSessions();
          if (generation === requestedGeneration) {
            result = listed;
            options.commitSessions(result);
          } else {
            result = options.currentSessions();
          }
        } catch (error) {
          if (generation === requestedGeneration) options.onError(error);
          result = options.currentSessions();
        }
        completedGeneration = generation;
      }
      return result;
    } finally {
      activeRefresh = undefined;
    }
  };

  return {
    refresh(): Promise<T[]> {
      requestedGeneration += 1;
      if (!activeRefresh) activeRefresh = drainRefreshes();
      return activeRefresh;
    },
  };
}

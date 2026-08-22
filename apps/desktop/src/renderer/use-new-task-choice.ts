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

import { useCallback, useEffect, useState } from 'react';
import { UNRESOLVED_NEW_TASK_DRAFT_KEY } from './new-task-reload-intent.js';

export function useNewTaskChoice<T>(targetKey: string): [T | undefined, (value: T) => void] {
  const [choices, setChoices] = useState(() => new Map<string, T>());
  const pendingTargetKey =
    targetKey !== UNRESOLVED_NEW_TASK_DRAFT_KEY &&
      choices.has(UNRESOLVED_NEW_TASK_DRAFT_KEY)
      ? UNRESOLVED_NEW_TASK_DRAFT_KEY
      : targetKey;

  const setChoice = useCallback((value: T) => {
    setChoices((current) => {
      const next = new Map(current).set(targetKey, value);
      if (targetKey !== UNRESOLVED_NEW_TASK_DRAFT_KEY) {
        next.delete(UNRESOLVED_NEW_TASK_DRAFT_KEY);
      }
      return next;
    });
  }, [targetKey]);

  useEffect(() => {
    if (targetKey === UNRESOLVED_NEW_TASK_DRAFT_KEY) return;
    setChoices((current) => {
      if (!current.has(UNRESOLVED_NEW_TASK_DRAFT_KEY)) return current;
      const next = new Map(current);
      next.set(targetKey, next.get(UNRESOLVED_NEW_TASK_DRAFT_KEY) as T);
      next.delete(UNRESOLVED_NEW_TASK_DRAFT_KEY);
      return next;
    });
  }, [targetKey]);

  return [choices.get(pendingTargetKey), setChoice];
}

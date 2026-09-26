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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNewTaskChoiceProjectHandoff } from './new-task-choice-project-handoff.js';

export const UNRESOLVED_NEW_TASK_DRAFT_KEY = 'new-task:unresolved';

export function useNewTaskChoice<T>(
  targetKey: string,
  options: {
    readonly projectHandoffEnabled?: boolean;
    readonly acceptProjectHandoff?: (value: T) => boolean;
    readonly projectHandoffIdentity?: string;
  } = {},
): [T | undefined, (value: T) => void, () => void] {
  const [choices, setChoices] = useState(() => new Map<string, T>());
  const { handoff, consume } = useNewTaskChoiceProjectHandoff();
  const projectHandoffIdentitiesRef = useRef(new Map<string, string | undefined>());
  if (!choices.has(targetKey)) {
    projectHandoffIdentitiesRef.current.set(targetKey, options.projectHandoffIdentity);
  }
  const pendingTargetKey =
    targetKey !== UNRESOLVED_NEW_TASK_DRAFT_KEY && choices.has(UNRESOLVED_NEW_TASK_DRAFT_KEY)
      ? UNRESOLVED_NEW_TASK_DRAFT_KEY
      : targetKey;
  const setChoice = useCallback((value: T) => {
    // Keep the identity under which an explicit choice was made, even if a
    // catalog refresh later replaces the effective model before project add.
    projectHandoffIdentitiesRef.current.set(targetKey, options.projectHandoffIdentity);
    setChoices((current) => {
      const next = new Map(current).set(targetKey, value);
      if (targetKey !== UNRESOLVED_NEW_TASK_DRAFT_KEY) next.delete(UNRESOLVED_NEW_TASK_DRAFT_KEY);
      return next;
    });
  }, [options.projectHandoffIdentity, targetKey]);
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
  const sourceIdentity = handoff
    ? projectHandoffIdentitiesRef.current.get(handoff.fromKey)
    : undefined;
  const sourceChoice = handoff ? choices.get(handoff.fromKey) : undefined;
  // Resolve the handoff during render so dependent choices (thinking after
  // model selection) see the destination model before any consumer clears it.
  const inheritedChoice = handoff?.toKey === targetKey &&
    options.projectHandoffEnabled && !choices.has(pendingTargetKey) &&
    sourceIdentity !== undefined && sourceIdentity === options.projectHandoffIdentity &&
    sourceChoice !== undefined && options.acceptProjectHandoff?.(sourceChoice)
    ? sourceChoice
    : undefined;
  useEffect(() => {
    if (!handoff || !options.projectHandoffEnabled || handoff.fromKey === targetKey) return;
    if (inheritedChoice !== undefined) {
      setChoices((current) => current.has(targetKey)
        ? current
        : new Map(current).set(targetKey, inheritedChoice));
    }
    consume(handoff.token);
  }, [consume, handoff, inheritedChoice, options.projectHandoffEnabled, targetKey]);
  const clearChoice = useCallback(() => {
    setChoices((current) => {
      if (!current.has(targetKey) && !current.has(UNRESOLVED_NEW_TASK_DRAFT_KEY)) return current;
      const next = new Map(current);
      next.delete(targetKey);
      next.delete(UNRESOLVED_NEW_TASK_DRAFT_KEY);
      return next;
    });
  }, [targetKey]);
  return [choices.has(pendingTargetKey) ? choices.get(pendingTargetKey) : inheritedChoice, setChoice, clearChoice];
}

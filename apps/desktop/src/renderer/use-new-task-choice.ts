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

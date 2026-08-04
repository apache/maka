const NEW_TASK_RELOAD_INTENT_KEY = 'maka-new-task-reload-intent-v1';

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function rendererSessionStorage(): SessionStorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * A renderer-reload lease for the explicit empty new-task surface.
 * sessionStorage survives HMR/navigation reloads but not a new application
 * window, so ordinary cold-start history restoration remains unchanged.
 */
export function hasNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): boolean {
  try {
    return storage?.getItem(NEW_TASK_RELOAD_INTENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function markNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): void {
  try {
    storage?.setItem(NEW_TASK_RELOAD_INTENT_KEY, '1');
  } catch {
    // Restricted renderer contexts may not expose web storage.
  }
}

export function clearNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): void {
  try {
    storage?.removeItem(NEW_TASK_RELOAD_INTENT_KEY);
  } catch {
    // Restricted renderer contexts may not expose web storage.
  }
}

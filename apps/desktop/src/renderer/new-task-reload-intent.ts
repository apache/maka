const NEW_TASK_RELOAD_INTENT_KEY = 'maka-new-task-reload-intent-v1';

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface NewTaskReloadIntent {
  draft: string;
}

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
    return readNewTaskReloadIntent(storage) !== undefined;
  } catch {
    return false;
  }
}

export function markNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): void {
  try {
    const existing = readNewTaskReloadIntent(storage);
    storage?.setItem(
      NEW_TASK_RELOAD_INTENT_KEY,
      JSON.stringify({ draft: existing?.draft ?? '' } satisfies NewTaskReloadIntent),
    );
  } catch {
    // Restricted renderer contexts may not expose web storage.
  }
}

export function readNewTaskReloadIntent(
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): NewTaskReloadIntent | undefined {
  try {
    const raw = storage?.getItem(NEW_TASK_RELOAD_INTENT_KEY);
    if (!raw) return undefined;
    // The original marker shipped as the literal `1`. Keep reloads made by
    // that version fail-soft while treating the marker as surface state only.
    if (raw === '1') return { draft: '' };
    const parsed = JSON.parse(raw) as Partial<NewTaskReloadIntent>;
    if (typeof parsed.draft !== 'string') return undefined;
    return { draft: parsed.draft };
  } catch {
    return undefined;
  }
}

export function writeNewTaskReloadDraft(
  draft: string,
  storage: SessionStorageLike | undefined = rendererSessionStorage(),
): void {
  try {
    const intent = readNewTaskReloadIntent(storage);
    if (!intent) return;
    storage?.setItem(NEW_TASK_RELOAD_INTENT_KEY, JSON.stringify({ ...intent, draft }));
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

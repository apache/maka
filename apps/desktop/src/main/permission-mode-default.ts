import type { AppSettings, ChatDefaultPermissionMode } from '@maka/core/settings';

/** Read the configured chat-default permission mode; fall back to 'ask' if
 *  settings cannot be read (so session creation never fails on a corrupted
 *  settings.json). Injected so the fallback is unit-testable. */
export async function resolveDefaultPermissionMode(
  readSettings: () => Promise<AppSettings>,
): Promise<ChatDefaultPermissionMode> {
  try {
    return (await readSettings()).chatDefaults.permissionMode;
  } catch {
    return 'ask';
  }
}

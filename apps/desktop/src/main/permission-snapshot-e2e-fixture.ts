import type { OsPermissionSnapshot, OsPermissionState, PermissionSnapshot } from '@maka/core/capabilities';

/**
 * #1361: a typed OS-permission snapshot for the `settings-permissions` e2e
 * fixture.
 *
 * The Permission Center's narrow-layout contract is about what happens when a
 * row carries several grant buttons: the row grid's `auto` actions track used to beat
 * the body's `minmax(0, 1fr)` and squeeze it to 0px, hiding which permission
 * the row was even about. Reading the host's real TCC state cannot exercise
 * that — a fully-granted dev machine renders no buttons at all, and Linux CI
 * reports most permissions as `unsupported`, so the assertion would pass
 * without testing anything.
 *
 * This fixture pins the states that matter instead:
 *   - `screen_recording` — `not_determined` + requestable + openable, the
 *     three-action shape (open, guided drag, request) that exercises the squeeze;
 *   - `accessibility` / `notifications` — `granted`, no buttons;
 *   - `automation` — `unsupported`, which carries the widest status Badge
 *     ("当前平台不支持", ~101px intrinsic and `whitespace-nowrap` by primitive
 *     contract) and so sets the row's minimum readable width.
 *
 * Mirrors the Storybook fixture in `stories/settings/settings-pages.stories.tsx`
 * so the story baseline and the E2E contract describe the same page.
 *
 * Production is untouched: this returns null unless the fixture scenario is
 * active, and `registerPermissionsIpc` falls back to `buildPermissionSnapshot`.
 */
const FIXTURE_SCENARIO = 'settings-permissions';

type OsPermissionId = keyof PermissionSnapshot['permissions'];

function fixtureOsPermission(input: {
  id: OsPermissionId;
  status: OsPermissionState;
  now: number;
  reason?: string;
  canRequest?: boolean;
  canOpenSettings?: boolean;
}): OsPermissionSnapshot {
  return {
    id: input.id,
    status: input.status,
    source: 'static',
    checkedAt: input.now,
    reason: input.reason,
    canOpenSettings: input.canOpenSettings ?? input.status !== 'unsupported',
    canRequest: input.canRequest ?? false,
  };
}

export function permissionSnapshotE2eFixture(now: number): PermissionSnapshot | null {
  if (process.env.MAKA_E2E_FIXTURE !== FIXTURE_SCENARIO) return null;
  return {
    checkedAt: now,
    platform: 'darwin',
    permissions: {
      accessibility: fixtureOsPermission({ id: 'accessibility', status: 'granted', now }),
      screen_recording: fixtureOsPermission({
        id: 'screen_recording',
        status: 'not_determined',
        now,
        canRequest: true,
      }),
      notifications: fixtureOsPermission({
        id: 'notifications',
        status: 'granted',
        now,
        canRequest: true,
      }),
      automation: fixtureOsPermission({
        id: 'automation',
        status: 'unsupported',
        now,
        reason: '当前系统版本不暴露自动化授权状态。',
        canOpenSettings: false,
      }),
    },
  };
}

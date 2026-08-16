/**
 * PR-PERMISSION-PAGE-REDESIGN — actionable side of the Permission Center.
 *
 * The old `permissions:getSnapshot` is purely read-only; the user could
 * see status pills but couldn't actually do anything. This module adds
 * two side-effectful IPC handlers:
 *
 *   - `openSystemPermissionPane(id)` — deep-links into macOS System
 *     Settings → Privacy & Security at the right pane. On non-macOS
 *     platforms the request resolves with a structured "unsupported"
 *     failure so the renderer can hide the button.
 *   - `requestPermissionAccess(id)` — when the OS exposes a real,
 *     result-bearing consent path (screen capture) we engage it;
 *     otherwise we deep-link to System Settings. Merely showing a
 *     notification is not treated as proof that notifications are allowed.
 *
 * No state is persisted here. The renderer refreshes after a direct
 * request resolves, and again when the app regains focus after a
 * System Settings deep link.
 */

import { desktopCapturer, shell, systemPreferences } from 'electron';
import type { OsPermissionId } from '@maka/core/capabilities';
import { OS_PERMISSION_IDS } from '@maka/core/capabilities';
import { planPermissionRequest, requestScreenCaptureConsent } from './os-permission-policy.js';

export type PermissionActionResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'invalid_id'
        | 'unsupported_platform'
        | 'unsupported_permission'
        | 'open_settings_failed'
        | 'denied'
        | 'failed';
      message?: string;
    };

/**
 * macOS x-apple.systempreferences deep-link targets. The format changed
 * across macOS versions; the strings below are the "modern" (Ventura+)
 * Privacy & Security pane URIs which are also still accepted on
 * Monterey. We do not include a Sequoia-only fallback because Electron
 * passes the URL through `shell.openExternal` either way.
 */
const MACOS_DEEP_LINKS: Record<OsPermissionId, string | null> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
};

function normalizePermissionId(input: unknown): OsPermissionId | null {
  if (typeof input !== 'string') return null;
  return (OS_PERMISSION_IDS as readonly string[]).includes(input)
    ? (input as OsPermissionId)
    : null;
}

export async function openSystemPermissionPane(input: unknown): Promise<PermissionActionResult> {
  const id = normalizePermissionId(input);
  if (!id) return { ok: false, reason: 'invalid_id' };
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported_platform' };
  }
  const url = MACOS_DEEP_LINKS[id];
  if (!url) return { ok: false, reason: 'unsupported_permission' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'open_settings_failed', message: errorMessage(err) };
  }
}

export async function requestPermissionAccess(input: unknown): Promise<PermissionActionResult> {
  const id = normalizePermissionId(input);
  if (!id) return { ok: false, reason: 'invalid_id' };
  try {
    const plan = planPermissionRequest({
      id,
      platform: process.platform,
      screenStatus:
        id === 'screen_recording' && process.platform === 'darwin'
          ? systemPreferences.getMediaAccessStatus('screen')
          : undefined,
    });
    switch (plan) {
      case 'unsupported_platform':
        return { ok: false, reason: 'unsupported_platform' };
      case 'already_granted':
        return { ok: true };
      case 'request_screen_capture': {
        // macOS has no askForMediaAccess('screen'). A real capture-source
        // request is the Electron-supported way to engage the screen capture
        // consent path; if TCC still reports denied, take the user directly to
        // the pane where the grant must be completed.
        const outcome = await requestScreenCaptureConsent({
          capture: async () => {
            await desktopCapturer.getSources({
              types: ['screen'],
              thumbnailSize: { width: 1, height: 1 },
            });
          },
          status: () => systemPreferences.getMediaAccessStatus('screen'),
        });
        return outcome === 'granted'
          ? { ok: true }
          : openSystemPermissionPane(id);
      }
      case 'open_settings':
        return openSystemPermissionPane(id);
    }
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorMessage(err) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

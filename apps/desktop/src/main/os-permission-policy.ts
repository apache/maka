import type { OsPermissionId, OsPermissionState } from '@maka/core';

export function mapMediaAccessStatus(status: string): OsPermissionState {
  switch (status) {
    case 'granted':
      return 'granted';
    case 'denied':
    case 'restricted':
      return 'denied';
    case 'not-determined':
      return 'not_determined';
    default:
      return 'unknown';
  }
}

export function supportsMediaPermissionProbe(
  id: 'screen_recording' | 'microphone',
  platform: NodeJS.Platform,
): boolean {
  if (id === 'screen_recording') return platform === 'darwin';
  return platform === 'darwin' || platform === 'win32';
}

export function mediaPermissionActions(input: {
  id: 'screen_recording' | 'microphone';
  platform: NodeJS.Platform;
  status: OsPermissionState;
}): { canOpenSettings: boolean; canRequest: boolean } {
  return {
    canOpenSettings: input.platform === 'darwin',
    canRequest:
      input.platform === 'darwin'
      && ((input.id === 'microphone' && input.status === 'not_determined')
        || (input.id === 'screen_recording' && input.status !== 'granted')),
  };
}

export type PermissionRequestPlan =
  | 'unsupported_platform'
  | 'already_granted'
  | 'request_screen_capture'
  | 'request_microphone'
  | 'open_settings';

export function planPermissionRequest(input: {
  id: OsPermissionId;
  platform: NodeJS.Platform;
  microphoneStatus?: string;
  screenStatus?: string;
}): PermissionRequestPlan {
  if (input.platform !== 'darwin') return 'unsupported_platform';
  if (input.id === 'screen_recording') {
    return input.screenStatus === 'granted' ? 'already_granted' : 'request_screen_capture';
  }
  if (input.id !== 'microphone') return 'open_settings';
  if (input.microphoneStatus === 'granted') return 'already_granted';
  if (input.microphoneStatus === 'not-determined') return 'request_microphone';
  return 'open_settings';
}

export async function requestScreenCaptureConsent(deps: {
  capture(): Promise<void>;
  status(): string;
}): Promise<'granted' | 'open_settings'> {
  try {
    await deps.capture();
  } catch {
    // A denied first request is expected; System Settings is the recovery.
  }
  return deps.status() === 'granted' ? 'granted' : 'open_settings';
}

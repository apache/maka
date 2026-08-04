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
      && input.id === 'microphone'
      && input.status === 'not_determined',
  };
}

export type PermissionRequestPlan =
  | 'unsupported_platform'
  | 'already_granted'
  | 'request_microphone'
  | 'open_settings';

export function planPermissionRequest(input: {
  id: OsPermissionId;
  platform: NodeJS.Platform;
  microphoneStatus?: string;
}): PermissionRequestPlan {
  if (input.platform !== 'darwin') return 'unsupported_platform';
  if (input.id !== 'microphone') return 'open_settings';
  if (input.microphoneStatus === 'granted') return 'already_granted';
  if (input.microphoneStatus === 'not-determined') return 'request_microphone';
  return 'open_settings';
}

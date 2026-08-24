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

import type { OsPermissionId, OsPermissionState } from '@maka/core/capabilities';

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
  id: 'screen_recording',
  platform: NodeJS.Platform,
): boolean {
  return id === 'screen_recording' && platform === 'darwin';
}

export function mediaPermissionActions(input: {
  id: 'screen_recording';
  platform: NodeJS.Platform;
  status: OsPermissionState;
}): { canOpenSettings: boolean; canRequest: boolean } {
  return {
    canOpenSettings: input.platform === 'darwin',
    canRequest:
      input.platform === 'darwin'
      && input.id === 'screen_recording'
      && input.status !== 'granted',
  };
}

export type PermissionRequestPlan =
  | 'unsupported_platform'
  | 'already_granted'
  | 'request_screen_capture'
  | 'open_settings';

export function planPermissionRequest(input: {
  id: OsPermissionId;
  platform: NodeJS.Platform;
  screenStatus?: string;
}): PermissionRequestPlan {
  if (input.platform !== 'darwin') return 'unsupported_platform';
  if (input.id === 'screen_recording') {
    return input.screenStatus === 'granted' ? 'already_granted' : 'request_screen_capture';
  }
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

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

import { createRequire } from 'node:module';
import type { OsPermissionSnapshot } from '@maka/core/capabilities';

const require = createRequire(import.meta.url);

function readNativeAuthorizationStatus(): Promise<number> {
  if (process.type !== 'browser') {
    throw new Error('Notification settings must be queried in the Electron main process');
  }
  const bridge = require('../native/notification-settings.node') as {
    getAuthorizationStatus(): Promise<number>;
  };
  return bridge.getAuthorizationStatus();
}

export function createNotificationAuthorizationReader(
  read: () => Promise<number> = readNativeAuthorizationStatus,
): () => Promise<number> {
  let inFlight: Promise<number> | undefined;
  return () => {
    // Share only pending work: a later refresh must observe System Settings changes.
    inFlight ??= Promise.resolve().then(read).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

const readAuthorizationStatus = createNotificationAuthorizationReader();

export async function notificationPermissionSnapshot(
  now: number,
  platform: NodeJS.Platform,
  supported: boolean,
  read: () => Promise<number> = readAuthorizationStatus,
): Promise<OsPermissionSnapshot> {
  const snapshot: OsPermissionSnapshot = {
    id: 'notifications',
    status: supported ? 'unknown' : 'unsupported',
    source: platform === 'darwin' ? 'platform' : 'electron',
    checkedAt: now,
    canOpenSettings: platform === 'darwin',
    // Reading settings must never trigger a consent prompt or send a notification.
    canRequest: false,
  };
  if (!supported) return { ...snapshot, reason: 'notifications_unsupported' };
  if (platform !== 'darwin') {
    return { ...snapshot, reason: 'notifications_status_unreadable' };
  }
  try {
    const status = await read();
    switch (status) {
      case 0:
        return { ...snapshot, status: 'not_determined' };
      case 1:
        return { ...snapshot, status: 'denied' };
      case 2:
        return { ...snapshot, status: 'granted' };
      case 3:
        return { ...snapshot, status: 'granted', reason: '仅允许安静通知，不显示横幅或播放声音' };
      default:
        return { ...snapshot, reason: `macOS 返回未知通知授权状态：${status}` };
    }
  } catch (error) {
    return {
      ...snapshot,
      reason: `macOS 通知权限查询失败：${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

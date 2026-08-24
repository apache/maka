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

import type {
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
  AppUpdateStatus,
} from '../preload/bridge-contract.js';

export type AppUpdateInstallOutcome =
  | { kind: 'install-started' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: 'not_downloaded' | 'install_failed' };

export function isAppUpdateInstallFailure(
  status: AppUpdateStatus | null,
): status is Extract<AppUpdateStatus, { state: 'error' }> {
  return status?.state === 'error' && status.operation === 'install';
}

export async function requestDownloadedAppUpdate(input: {
  installUpdate(request: AppUpdateInstallRequest): Promise<AppUpdateInstallResult>;
  confirmActiveTasks(): Promise<boolean>;
}): Promise<AppUpdateInstallOutcome> {
  const guarded = await input.installUpdate({ allowInterruptActiveTasks: false });
  if (guarded.ok) return { kind: 'install-started' };
  if (guarded.reason !== 'active_tasks') return { kind: 'failed', reason: guarded.reason };
  if (!await input.confirmActiveTasks()) return { kind: 'cancelled' };

  const authorized = await input.installUpdate({ allowInterruptActiveTasks: true });
  return authorized.ok
    ? { kind: 'install-started' }
    : { kind: 'failed', reason: authorized.reason === 'active_tasks' ? 'install_failed' : authorized.reason };
}

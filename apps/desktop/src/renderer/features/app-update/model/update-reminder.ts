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

import type { AppUpdateStatus } from '../ports.js';

export interface AppUpdateReminder {
  readonly state: 'downloaded' | 'error';
  readonly latestVersion: string;
}

/** The single answer to "which update states need the user". */
export function updateReminderFromStatus(
  status: AppUpdateStatus | null,
): AppUpdateReminder | undefined {
  if (status?.state === 'downloaded') {
    return { state: 'downloaded', latestVersion: status.latestVersion };
  }
  if (status?.state === 'error' && status.latestVersion) {
    return { state: 'error', latestVersion: status.latestVersion };
  }
  return undefined;
}

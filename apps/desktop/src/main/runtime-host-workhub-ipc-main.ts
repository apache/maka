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

import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';

type RuntimeHostWorkHubClient = Pick<
  DesktopRuntimeHostClient,
  | 'answerWorkHubCoordination'
  | 'recordWorkHubCoordination'
  | 'resolveWorkHubCoordinationSession'
>;

/** Projects the Runtime Host WorkHub domain onto renderer IPC. */
export function registerRuntimeHostWorkHubIpc(
  client: RuntimeHostWorkHubClient,
  ipcMain: Pick<ReconnectableReadIpcMain, 'handle'>,
): void {
  ipcMain.handle('workhub:resolveCoordinationSession', () =>
    client.resolveWorkHubCoordinationSession(),
  );
  ipcMain.handle('workhub:answer', (_event, input) =>
    client.answerWorkHubCoordination(input),
  );
  ipcMain.handle('workhub:record', (_event, input) =>
    client.recordWorkHubCoordination(input),
  );
}

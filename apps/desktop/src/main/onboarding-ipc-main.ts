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

import { ipcMain } from 'electron';
import type { createOnboardingService } from './onboarding-service.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

export interface OnboardingIpcDeps {
  onboardingService: ReturnType<typeof createOnboardingService>;
  ipcMain?: ReconnectableReadIpcMain;
}

export function registerOnboardingIpc(deps: OnboardingIpcDeps): void {
  const target = deps.ipcMain ?? ipcMain;
  // PR110b: Onboarding snapshot + milestone IPCs. Renderer polls via
  // these on app load and whenever `sessions:changed` /
  // `connections:changed` / settings change events fire. No push from
  // main.
  handleReconnectableRead(target, 'onboarding:getSnapshot', async () =>
    deps.onboardingService.getSnapshot(),
  );
  target.handle('onboarding:setMilestone', async (_event, id: unknown, status: unknown) => {
    // Service throws INVALID_MILESTONE_ID / INVALID_MILESTONE_STATUS
    // for bad inputs; let the error propagate so the renderer sees
    // it as a typed reject rather than silently swallowing.
    return deps.onboardingService.setMilestone(id, status);
  });
}

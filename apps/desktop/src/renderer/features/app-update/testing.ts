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

import type { AppUpdateServices } from './ports.js';

export { AppUpdateServicesProvider } from './services-context.js';
export { AppUpdateProvider } from './ui/app-update-provider.js';
export { AppUpdateAboutProjectionConsumer } from './ui/app-update-projection-context.js';
export type { AppUpdateAboutProjection } from './ui/app-update-projection-context.js';
export {
  isAppUpdateInstallFailure,
  requestDownloadedAppUpdate,
} from './model/install-update.js';
export {
  useAppUpdateController,
  type AppUpdateController,
} from './controller/use-app-update-controller.js';
export type {
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
  AppUpdateServices,
  AppUpdateStatus,
} from './ports.js';

const noopSubscription = (): (() => void) => () => undefined;

export function createFakeAppUpdateServices(
  overrides: Partial<AppUpdateServices> = {},
): AppUpdateServices {
  return {
    appUpdate: {
      updateStatus: async () => ({ state: 'idle', currentVersion: '0.0.0' }),
      checkForUpdates: async () => ({ state: 'idle', currentVersion: '0.0.0' }),
      retryUpdateDownload: async () => ({ state: 'idle', currentVersion: '0.0.0' }),
      installUpdate: async () => ({ ok: false, reason: 'not_downloaded' }),
      subscribeUpdateStatus: noopSubscription,
    },
    ...overrides,
  };
}

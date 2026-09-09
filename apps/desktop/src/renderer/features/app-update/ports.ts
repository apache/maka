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
} from '../../../shared/app-update.js';

export type {
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
  AppUpdateStatus,
} from '../../../shared/app-update.js';

export type AppUpdateUnsubscribe = () => void;

/** The minimum environment capability needed by the App Update feature. */
export interface AppUpdateService {
  updateStatus(): Promise<AppUpdateStatus>;
  checkForUpdates(): Promise<AppUpdateStatus>;
  retryUpdateDownload(): Promise<AppUpdateStatus>;
  installUpdate(input: AppUpdateInstallRequest): Promise<AppUpdateInstallResult>;
  subscribeUpdateStatus(handler: (status: AppUpdateStatus) => void): AppUpdateUnsubscribe;
}

export interface AppUpdateServices {
  appUpdate: AppUpdateService;
}

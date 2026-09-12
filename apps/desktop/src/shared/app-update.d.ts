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

export type AppUpdateProgress = {
  percent: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
};

export type AppUpdateStatus =
  | { state: 'idle'; currentVersion: string }
  | { state: 'checking'; currentVersion: string }
  | { state: 'not-available'; currentVersion: string; latestVersion?: string }
  | {
      state: 'available';
      currentVersion: string;
      latestVersion: string;
    }
  | {
      state: 'downloading';
      currentVersion: string;
      latestVersion: string;
      progress: AppUpdateProgress;
    }
  | { state: 'verifying'; currentVersion: string; latestVersion: string }
  | {
      state: 'downloaded';
      currentVersion: string;
      latestVersion: string;
    }
  | { state: 'installing'; currentVersion: string; latestVersion: string }
  | {
      state: 'error';
      currentVersion: string;
      message: string;
      operation: 'check' | 'download' | 'install';
      latestVersion?: string;
    };

export type AppUpdateInstallRequest = {
  /** User consent from the trusted desktop renderer; this is a UX boundary, not a security boundary. */
  allowInterruptActiveTasks: boolean;
};

export type AppUpdateInstallResult =
  | { ok: true }
  | { ok: false; reason: 'active_tasks' }
  | { ok: false; reason: 'not_downloaded' | 'install_failed' };

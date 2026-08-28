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

import { closeSync } from 'node:fs';

export const RUNTIME_HOST_LAUNCH_OWNER_LEASE_FD_ENV = 'MAKA_RUNTIME_HOST_LAUNCH_OWNER_LEASE_FD';
export const RUNTIME_HOST_LAUNCH_OWNER_RELEASE_KIND = 'runtime-host-launch-owner-release';

export interface RuntimeHostLaunchOwnerGuard {
  bind(closeHost: () => Promise<unknown>): void;
  dispose(): Promise<void>;
}

/**
 * Keeps the updater's authority lease inside a Candidate until its launcher
 * explicitly releases it. Launcher loss closes the Host before the lease, so
 * no second owner can enter while the uncommitted target remains a writer.
 */
export function createRuntimeHostLaunchOwnerGuard(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeHostLaunchOwnerGuard | undefined {
  const rawFd = env[RUNTIME_HOST_LAUNCH_OWNER_LEASE_FD_ENV];
  if (rawFd === undefined) return undefined;
  const leaseFd = Number(rawFd);
  if (!Number.isSafeInteger(leaseFd) || leaseFd < 3) {
    throw new Error('Runtime Host launch-owner authority descriptor is invalid');
  }

  let state: 'owned' | 'released' | 'lost' = process.connected ? 'owned' : 'lost';
  let closeHost: (() => Promise<unknown>) | undefined;
  let lossSettlement: Promise<void> | undefined;
  let leaseClosed = false;

  const closeLease = () => {
    if (leaseClosed) return;
    leaseClosed = true;
    closeSync(leaseFd);
  };
  const settleLoss = () => {
    if (state !== 'lost' || !closeHost || lossSettlement) return;
    lossSettlement = Promise.resolve()
      .then(closeHost)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(closeLease);
  };
  const onMessage = (message: unknown) => {
    if (
      state !== 'owned' ||
      typeof message !== 'object' ||
      message === null ||
      (message as { kind?: unknown }).kind !== RUNTIME_HOST_LAUNCH_OWNER_RELEASE_KIND
    ) {
      return;
    }
    state = 'released';
    closeLease();
  };
  const onDisconnect = () => {
    if (state !== 'owned') return;
    state = 'lost';
    settleLoss();
  };
  process.on('message', onMessage);
  process.once('disconnect', onDisconnect);

  return {
    bind(close) {
      closeHost = close;
      settleLoss();
    },
    async dispose() {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      await lossSettlement;
      closeLease();
    },
  };
}

export function runtimeHostLaunchOwnerReleaseMessage(): {
  readonly kind: typeof RUNTIME_HOST_LAUNCH_OWNER_RELEASE_KIND;
} {
  return { kind: RUNTIME_HOST_LAUNCH_OWNER_RELEASE_KIND };
}

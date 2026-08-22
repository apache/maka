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

import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import {
  parseRuntimeHostSetupEndpoint,
  type RuntimeHostSetupPhase,
} from '@maka/runtime-host/operator';
import type {
  DesktopRuntimeHostOnboardingInput,
  DesktopRuntimeHostOnboardingSnapshot,
} from '../preload/bridge-contract.js';
import type { DesktopRuntimeHostProfileService } from './runtime-host-profile-service.js';
import type {
  DesktopRuntimeHostSetupPackage,
  DesktopRuntimeHostSshSetupInput,
} from './runtime-host-ssh-terminal.js';

type OnboardingState = DesktopRuntimeHostOnboardingSnapshot extends infer Snapshot
  ? Snapshot extends DesktopRuntimeHostOnboardingSnapshot
    ? Omit<Snapshot, 'revision'>
    : never
  : never;

export function createDesktopRuntimeHostOnboarding(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly clientInstanceId: string;
  readonly profiles: Pick<DesktopRuntimeHostProfileService, 'addAndEnableVerified'>;
  readonly runSetup: (
    input: DesktopRuntimeHostSshSetupInput,
    onProgress: (frame: { readonly phase: RuntimeHostSetupPhase }) => void,
    onComplete: () => void,
  ) => Promise<{
    readonly rootId: string;
    readonly rootPath: string;
    readonly serviceId: string;
    readonly operatorPath: string;
    readonly endpoint: string;
    readonly credential: string;
  }>;
  readonly send: (snapshot: DesktopRuntimeHostOnboardingSnapshot) => void;
  readonly resolveSetupPackage: () => DesktopRuntimeHostSetupPackage;
}): { close(): Promise<void> } {
  let revision = 0;
  let snapshot: DesktopRuntimeHostOnboardingSnapshot = { kind: 'idle', revision };
  let active:
    | {
        readonly abort: AbortController;
        readonly task: Promise<DesktopRuntimeHostOnboardingSnapshot>;
        cancellable: boolean;
      }
    | undefined;

  const publish = (
    next: OnboardingState,
  ): DesktopRuntimeHostOnboardingSnapshot => {
    revision += 1;
    snapshot = { ...next, revision } as DesktopRuntimeHostOnboardingSnapshot;
    input.send(snapshot);
    return snapshot;
  };

  const start = (value: unknown): Promise<DesktopRuntimeHostOnboardingSnapshot> => {
    if (active) return active.task;
    let request: DesktopRuntimeHostOnboardingInput;
    try {
      request = requireOnboardingInput(value);
    } catch (error) {
      return Promise.resolve(publish({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    const abort = new AbortController();
    publish({ kind: 'running', phase: 'connecting_ssh' });
    const task = Promise.resolve().then(() => run(request, abort.signal)).finally(() => {
      if (active?.task === task) active = undefined;
    });
    active = { abort, task, cancellable: true };
    return task;
  };

  const run = async (
    request: DesktopRuntimeHostOnboardingInput,
    signal: AbortSignal,
  ): Promise<DesktopRuntimeHostOnboardingSnapshot> => {
    try {
      let commitStarted = false;
      const beginCommit = () => {
        if (commitStarted) return;
        commitStarted = true;
        if (active) active.cancellable = false;
        publish({
          kind: 'running',
          phase: 'connecting_host',
        });
      };
      const complete = await input.runSetup(
        {
          destination: request.destination,
          ...(request.sshPort === undefined ? {} : { sshPort: request.sshPort }),
          setupPackage: input.resolveSetupPackage(),
          principalId: `desktop:${input.clientInstanceId}`,
          signal,
        },
        (progress) => {
          if (commitStarted) return;
          publish({
            kind: 'running',
            phase: progress.phase,
          });
        },
        beginCommit,
      );
      beginCommit();
      const endpoint = parseRuntimeHostSetupEndpoint(complete.endpoint);
      if (!endpoint) throw new Error('Remote Maka setup returned an invalid endpoint');
      const profileId = `remote-${randomUUID()}`;
      const profileName = request.name?.trim() || request.destination;
      const connected = await input.profiles.addAndEnableVerified({
        profile: {
          id: profileId,
          name: profileName,
          kind: 'remote',
          rootId: complete.rootId,
          transport: {
            kind: 'ssh',
            destination: request.destination,
            ...(request.sshPort === undefined ? {} : { sshPort: request.sshPort }),
            remotePort: endpoint.port,
            websocketPath: endpoint.websocketPath,
          },
        },
        credential: complete.credential,
        managedService: {
          id: complete.serviceId,
          rootPath: complete.rootPath,
          operatorPath: complete.operatorPath,
        },
      });
      return publish({
        kind: 'complete',
        profileId: connected.profileId,
      });
    } catch (error) {
      if (signal.aborted) return publish({ kind: 'idle' });
      return publish({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const channels = [
    'runtime-host-onboarding:getSnapshot',
    'runtime-host-onboarding:start',
    'runtime-host-onboarding:cancel',
    'runtime-host-onboarding:reset',
  ] as const;
  input.ipcMain.handle(channels[0], () => snapshot);
  input.ipcMain.handle(channels[1], (_event, value: unknown) => start(value));
  input.ipcMain.handle(channels[2], async () => {
    const current = active;
    if (!current) return true;
    if (!current.cancellable) return false;
    current.abort.abort();
    await current.task;
    return true;
  });
  input.ipcMain.handle(channels[3], async () => {
    if (snapshot.kind === 'running') return;
    await active?.task;
    publish({ kind: 'idle' });
  });

  return {
    close: async () => {
      for (const channel of channels) input.ipcMain.removeHandler(channel);
      const current = active;
      if (!current) return;
      if (current.cancellable) current.abort.abort();
      await current.task;
    },
  };
}

function requireOnboardingInput(value: unknown): DesktopRuntimeHostOnboardingInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote Runtime Host setup input is invalid');
  }
  const input = value as Partial<DesktopRuntimeHostOnboardingInput>;
  if (
    typeof input.destination !== 'string' ||
    input.destination.trim() !== input.destination ||
    input.destination.length === 0 ||
    input.destination.length > 512 ||
    (input.name !== undefined &&
      (typeof input.name !== 'string' || input.name.trim().length > 128)) ||
    (input.sshPort !== undefined &&
      (!Number.isInteger(input.sshPort) || input.sshPort < 1 || input.sshPort > 65_535))
  ) {
    throw new Error('Remote Runtime Host setup input is invalid');
  }
  return {
    destination: input.destination,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    ...(input.sshPort === undefined ? {} : { sshPort: input.sshPort }),
  };
}

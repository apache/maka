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
import type { DesktopRuntimeHostWslSetupInput } from './runtime-host-wsl-controller.js';
import type { DesktopRuntimeHostDevelopmentPeerTarget } from './runtime-host-setup-package.js';
import { requireProjectDirectoryRoots } from '../shared/runtime-host-project-directory-policy.js';

type OnboardingState = DesktopRuntimeHostOnboardingSnapshot extends infer Snapshot
  ? Snapshot extends DesktopRuntimeHostOnboardingSnapshot
    ? Omit<Snapshot, 'revision'>
    : never
  : never;

export function createDesktopRuntimeHostOnboarding(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly clientInstanceId: string;
  readonly profiles: Pick<DesktopRuntimeHostProfileService, 'addAndEnable' | 'addAndEnableVerified'>;
  readonly runSetup: (
    input: DesktopRuntimeHostSshSetupInput,
    onProgress: (frame: { readonly phase: RuntimeHostSetupPhase }) => void,
    onComplete: () => void,
  ) => Promise<{
    readonly rootId: string;
    readonly rootPath: string;
    readonly serviceId: string;
    readonly deploymentId: string;
    readonly operatorPath: string;
    readonly endpoint: string;
    readonly credential: string;
  }>;
  readonly runWslSetup: (
    input: DesktopRuntimeHostWslSetupInput,
    onProgress: (frame: { readonly phase: RuntimeHostSetupPhase }) => void,
    onComplete: () => void,
  ) => Promise<{ readonly rootId: string; readonly operatorPath: string }>;
  readonly listWslDistributions: () => Promise<readonly string[]>;
  readonly send: (snapshot: DesktopRuntimeHostOnboardingSnapshot) => void;
  readonly setupPackageMode: 'published' | 'development';
  readonly resolveSshDevelopmentPeerTarget: (input: {
    readonly destination: string;
    readonly sshPort?: number;
    readonly signal?: AbortSignal;
  }) => Promise<Exclude<DesktopRuntimeHostDevelopmentPeerTarget, 'none'>>;
  readonly resolveSetupPackage: (
    peerTarget: DesktopRuntimeHostDevelopmentPeerTarget,
    signal?: AbortSignal,
  ) => DesktopRuntimeHostSetupPackage | Promise<DesktopRuntimeHostSetupPackage>;
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
    publish({ kind: 'running', phase: 'preparing_cli' });
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
      if (request.kind === 'wsl') {
        const setupPackage = await input.resolveSetupPackage('none', signal);
        return await runWsl(request, setupPackage, signal);
      }
      const peerTarget = input.setupPackageMode === 'development'
        ? await resolveSshDevelopmentPeerTarget(request, signal)
        : 'none';
      const setupPackage = await input.resolveSetupPackage(peerTarget, signal);
      const lifecycle = setupPackage.kind === 'npm' ? 'on_demand' : 'supervised';
      signal.throwIfAborted();
      publish({ kind: 'running', phase: 'connecting_ssh' });
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
          setupPackage,
          lifecycle,
          principalId: `desktop:${input.clientInstanceId}`,
          ...(request.projectDirectoryRoots
            ? { projectDirectoryRoots: request.projectDirectoryRoots }
            : {}),
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
            ...(lifecycle === 'on_demand'
              ? {
                  activation: {
                    kind: 'ssh_operator' as const,
                    operatorPath: complete.operatorPath,
                  },
                }
              : {
                  remotePort: endpoint.port,
                  websocketPath: endpoint.websocketPath,
                }),
          },
        },
        credential: complete.credential,
        managedService: {
          deployment: {
            id: complete.serviceId,
            rootPath: complete.rootPath,
            deploymentId: complete.deploymentId,
          },
          control: {
            kind: 'ssh_operator',
            operatorPath: complete.operatorPath,
          },
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

  const resolveSshDevelopmentPeerTarget = async (
    request: Extract<DesktopRuntimeHostOnboardingInput, { readonly kind: 'ssh' }>,
    signal: AbortSignal,
  ): Promise<Exclude<DesktopRuntimeHostDevelopmentPeerTarget, 'none'>> => {
    publish({ kind: 'running', phase: 'connecting_ssh' });
    const target = await input.resolveSshDevelopmentPeerTarget({
      destination: request.destination,
      ...(request.sshPort === undefined ? {} : { sshPort: request.sshPort }),
      signal,
    });
    publish({ kind: 'running', phase: 'preparing_cli' });
    return target;
  };

  const runWsl = async (
    request: Extract<DesktopRuntimeHostOnboardingInput, { readonly kind: 'wsl' }>,
    setupPackage: DesktopRuntimeHostSetupPackage,
    signal: AbortSignal,
  ): Promise<DesktopRuntimeHostOnboardingSnapshot> => {
    publish({ kind: 'running', phase: 'connecting_wsl' });
    let commitStarted = false;
    const beginCommit = () => {
      if (commitStarted) return;
      commitStarted = true;
      if (active) active.cancellable = false;
      publish({ kind: 'running', phase: 'connecting_host' });
    };
    const complete = await input.runWslSetup(
      {
        distribution: request.distribution,
        setupPackage,
        principalId: `desktop:${input.clientInstanceId}`,
        ...(request.projectDirectoryRoots
          ? { projectDirectoryRoots: request.projectDirectoryRoots }
          : {}),
        signal,
      },
      (progress) => {
        if (!commitStarted) publish({ kind: 'running', phase: progress.phase });
      },
      beginCommit,
    );
    beginCommit();
    const profileId = `environment-${randomUUID()}`;
    const connected = await input.profiles.addAndEnable({
      profile: {
        id: profileId,
        name: request.name?.trim() || request.distribution,
        kind: 'environment',
        provider: { kind: 'wsl', distribution: request.distribution },
        rootId: complete.rootId,
        operatorPath: complete.operatorPath,
      },
    });
    if (connected.kind === 'unavailable') throw new Error(connected.message);
    return publish({ kind: 'complete', profileId });
  };

  const channels = [
    'runtime-host-onboarding:getSnapshot',
    'runtime-host-onboarding:start',
    'runtime-host-onboarding:cancel',
    'runtime-host-onboarding:reset',
    'runtime-host-onboarding:listWslDistributions',
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
  input.ipcMain.handle(channels[4], () => input.listWslDistributions());

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
  const input = value as Record<string, unknown>;
  if (input.name !== undefined &&
    (typeof input.name !== 'string' || input.name.trim().length > 128)) {
    throw new Error('Remote Runtime Host setup input is invalid');
  }
  const roots = input.projectDirectoryRoots === undefined
    ? undefined
    : requireProjectDirectoryRoots(input.projectDirectoryRoots);
  if (input.kind === 'wsl') {
    if (
      typeof input.distribution !== 'string' ||
      input.distribution.trim() !== input.distribution ||
      input.distribution.length === 0 ||
      input.distribution.length > 128
    ) throw new Error('WSL Runtime Host setup input is invalid');
    return {
      kind: 'wsl',
      distribution: input.distribution,
      ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
      ...(roots ? { projectDirectoryRoots: roots } : {}),
    };
  }
  if (
    input.kind !== 'ssh' ||
    typeof input.destination !== 'string' ||
    input.destination.trim() !== input.destination ||
    input.destination.length === 0 ||
    input.destination.length > 512 ||
    (input.sshPort !== undefined &&
      (!Number.isInteger(input.sshPort) || Number(input.sshPort) < 1 || Number(input.sshPort) > 65_535))
  ) throw new Error('Remote Runtime Host setup input is invalid');
  return {
    kind: 'ssh',
    destination: input.destination,
    ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
    ...(input.sshPort === undefined ? {} : { sshPort: Number(input.sshPort) }),
    ...(roots ? { projectDirectoryRoots: roots } : {}),
  };
}

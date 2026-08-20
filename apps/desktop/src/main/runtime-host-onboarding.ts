import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import {
  parseRuntimeHostSetupEndpoint,
  type RuntimeHostSetupPhase,
} from '@maka/runtime-host/client';
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
  readonly profiles: Pick<
    DesktopRuntimeHostProfileService,
    'addAndEnableVerified' | 'getSnapshot'
  >;
  readonly runSetup: (
    input: DesktopRuntimeHostSshSetupInput,
    onProgress: (frame: { readonly phase: RuntimeHostSetupPhase }) => void,
    onComplete: () => void,
  ) => Promise<{
    readonly rootId: string;
    readonly rootPath: string;
    readonly serviceId: string;
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
      const repairProfile = request.repairProfileId
        ? await resolveRepairProfile(input.profiles, request.repairProfileId)
        : undefined;
      const destination = repairProfile?.transport.kind === 'ssh'
        ? repairProfile.transport.destination
        : request.destination;
      const sshPort = repairProfile?.transport.kind === 'ssh'
        ? repairProfile.transport.sshPort
        : request.sshPort;
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
          destination,
          ...(sshPort === undefined ? {} : { sshPort }),
          setupPackage: input.resolveSetupPackage(),
          principalId: `desktop:${input.clientInstanceId}`,
          ...(repairProfile?.managedService
            ? {
                expectedServiceId: repairProfile.managedService.id,
                expectedRootPath: repairProfile.managedService.rootPath,
                expectedRootId: repairProfile.rootId,
              }
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
      const profileId = repairProfile?.id ?? `remote-${randomUUID()}`;
      const profileName = repairProfile?.name ?? (request.name?.trim() || destination);
      const connected = await input.profiles.addAndEnableVerified({
        profile: {
          id: profileId,
          name: profileName,
          kind: 'remote',
          rootId: complete.rootId,
          managedService: {
            id: complete.serviceId,
            rootPath: complete.rootPath,
          },
          transport: {
            kind: 'ssh',
            destination,
            ...(sshPort === undefined ? {} : { sshPort }),
            remotePort: endpoint.port,
            websocketPath: endpoint.websocketPath,
          },
        },
        credential: complete.credential,
        ...(repairProfile ? { expectedProfile: repairProfile } : {}),
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

async function resolveRepairProfile(
  profiles: Pick<DesktopRuntimeHostProfileService, 'getSnapshot'>,
  profileId: string,
) {
  const profile = (await profiles.getSnapshot()).entries.find(
    (entry) => entry.profile.id === profileId,
  )?.profile;
  if (
    profile?.kind !== 'remote' ||
    profile.transport.kind !== 'ssh' ||
    !profile.managedService
  ) {
    throw new Error('Managed Runtime Host repair target was not found');
  }
  return profile;
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
      (!Number.isInteger(input.sshPort) || input.sshPort < 1 || input.sshPort > 65_535)) ||
    (input.repairProfileId !== undefined &&
      (typeof input.repairProfileId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.repairProfileId)))
  ) {
    throw new Error('Remote Runtime Host setup input is invalid');
  }
  return {
    destination: input.destination,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    ...(input.sshPort === undefined ? {} : { sshPort: input.sshPort }),
    ...(input.repairProfileId ? { repairProfileId: input.repairProfileId } : {}),
  };
}

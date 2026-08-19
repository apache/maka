import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import type { RuntimeHostSetupPhase } from '@maka/runtime-host/client';
import type {
  DesktopRuntimeHostOnboardingInput,
  DesktopRuntimeHostOnboardingSnapshot,
} from '../preload/bridge-contract.js';
import type { DesktopRuntimeHostProfileService } from './runtime-host-profile-service.js';
import type {
  DesktopRuntimeHostSetupPackage,
  DesktopRuntimeHostSshSetupInput,
} from './runtime-host-ssh-terminal.js';

const SETUP_PACKAGE: DesktopRuntimeHostSetupPackage = {
  kind: 'npm',
  specifier: 'maka-agent@next',
};
type OnboardingState = DesktopRuntimeHostOnboardingSnapshot extends infer Snapshot
  ? Snapshot extends DesktopRuntimeHostOnboardingSnapshot
    ? Omit<Snapshot, 'revision'>
    : never
  : never;

export function createDesktopRuntimeHostOnboarding(input: {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  readonly clientInstanceId: string;
  readonly profiles: DesktopRuntimeHostProfileService;
  readonly runSetup: (
    input: DesktopRuntimeHostSshSetupInput,
    onProgress: (frame: { readonly phase: RuntimeHostSetupPhase }) => void,
  ) => Promise<{
    readonly rootId: string;
    readonly endpoint: string;
    readonly credential: string;
  }>;
  readonly send: (snapshot: DesktopRuntimeHostOnboardingSnapshot) => void;
  readonly setupPackage?: DesktopRuntimeHostSetupPackage;
}): { close(): Promise<void> } {
  let revision = 0;
  let snapshot: DesktopRuntimeHostOnboardingSnapshot = { kind: 'idle', revision };
  let active:
    | { readonly abort: AbortController; readonly task: Promise<DesktopRuntimeHostOnboardingSnapshot> }
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
    if (active) throw new Error('A remote Runtime Host setup is already in progress');
    const request = requireOnboardingInput(value);
    const abort = new AbortController();
    publish({ kind: 'running', destination: request.destination, phase: 'connecting_ssh' });
    const task = run(request, abort.signal).finally(() => {
      if (active?.task === task) active = undefined;
    });
    active = { abort, task };
    return task;
  };

  const run = async (
    request: DesktopRuntimeHostOnboardingInput,
    signal: AbortSignal,
  ): Promise<DesktopRuntimeHostOnboardingSnapshot> => {
    try {
      const complete = await input.runSetup(
        {
          destination: request.destination,
          ...(request.sshPort === undefined ? {} : { sshPort: request.sshPort }),
          setupPackage: input.setupPackage ?? SETUP_PACKAGE,
          principalId: `desktop:${input.clientInstanceId}`,
          signal,
        },
        (progress) => {
          publish({
            kind: 'running',
            destination: request.destination,
            phase: progress.phase,
          });
        },
      );
      signal.throwIfAborted();
      publish({
        kind: 'running',
        destination: request.destination,
        phase: 'connecting_host',
      });
      const endpoint = requireSetupEndpoint(complete.endpoint);
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
      });
      return publish({
        kind: 'complete',
        profileId: connected.profileId,
        profileName: connected.profileName,
      });
    } catch (error) {
      if (signal.aborted) return publish({ kind: 'idle' });
      return publish({
        kind: 'failed',
        destination: request.destination,
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
    if (!current) return;
    current.abort.abort();
    await current.task;
  });
  input.ipcMain.handle(channels[3], () => {
    if (active) throw new Error('Remote Runtime Host setup is still running');
    publish({ kind: 'idle' });
  });

  return {
    close: async () => {
      for (const channel of channels) input.ipcMain.removeHandler(channel);
      const current = active;
      if (!current) return;
      current.abort.abort();
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

function requireSetupEndpoint(value: string): { readonly port: number; readonly websocketPath: string } {
  const endpoint = new URL(value);
  const port = Number(endpoint.port);
  if (
    endpoint.protocol !== 'ws:' ||
    (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== '[::1]' && endpoint.hostname !== '::1') ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Remote Maka setup returned an invalid endpoint');
  }
  return { port, websocketPath: endpoint.pathname };
}

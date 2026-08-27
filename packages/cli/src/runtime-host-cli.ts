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

import { isAbsolute } from 'node:path';
import { isProductReleaseVersion } from '@maka/runtime-host/operator';
import type { RuntimeHostManagedUpdatePolicy } from '@maka/runtime-host/operator';
import {
  canonicalProjectDirectoryRootSpec,
  isCanonicalRuntimeHostWebSocketPath,
  PROJECT_DIRECTORY_MAX_ROOTS,
  projectDirectoryPosixRootSpecValid,
  projectDirectoryRootSpecValid,
} from '@maka/runtime-host/protocol';
import type { RuntimeHostManagedServiceTarget } from './runtime-host-service-manager.js';
import { hasEphemeralRuntimeHostPeerPort } from './runtime-host-peer-artifact.js';

type RuntimeHostCliError = { kind: 'error'; message: string; exitCode: number };

export type RuntimeHostUpdateSelector =
  | { readonly kind: 'channel'; readonly channel: 'latest' | 'next' }
  | { readonly kind: 'exact'; readonly version: string };

export type RuntimeHostCliCommand =
  | {
      kind: 'runtime-host-managed-activate';
      rootId: string;
      framed: true;
    }
  | {
      kind: 'runtime-host-serve';
      rootPath?: string;
      managedServiceConfigPath?: string;
      json: boolean;
      projectDirectoryRoots?: { label: string; path: string }[];
      websocket?: {
        host: string;
        port: number;
        path?: string;
        tlsCertificatePath?: string;
        tlsPrivateKeyPath?: string;
        allowedOrigins?: string[];
        allowInsecureRemote?: boolean;
      };
      peer?: {
        nativePath: string;
        keyPath: string;
        expectedPeerId?: string;
        listenAddresses?: string[];
        coordinationRelays?: string[];
      };
    }
  | {
      kind: 'runtime-host-setup';
      json: boolean;
      principalId: string;
      preset: 'desktop-client' | 'terminal-client';
      lifecycle: 'supervised' | 'on_demand';
      deferPairingCommit: boolean;
      bindPairingToClient?: true;
      clientDataRoot?: string;
      rootPath?: string;
      projectDirectoryRoots?: { label: string; path: string }[];
      websocketPort?: number;
      websocketPath?: string;
      directPeer?: {
        coordinationRelays: string[];
      };
      expectedTarget?: RuntimeHostManagedServiceTarget;
    }
  | {
      kind: 'runtime-host-service-manage';
      action:
        | 'install'
        | 'configure'
        | 'status'
        | 'start'
        | 'stop'
        | 'restart'
        | 'retire'
        | 'logs'
        | 'uninstall';
      json: boolean;
      framed?: true;
      clientDataRoot?: string;
      rootPath?: string;
      projectDirectoryRoots?: { label: string; path: string }[];
      websocketPort?: number;
      websocketPath?: string;
      expectedTarget?: RuntimeHostManagedServiceTarget;
      expectedConfigFingerprint?: string;
      retainManagedDeployment?: true;
      allowInterruptActiveTasks?: true;
    }
  | {
      kind: 'runtime-host-service-peer';
      action: 'enable' | 'disable' | 'status' | 'rotate' | 'descriptor';
      json: boolean;
      framed?: true;
      clientDataRoot?: string;
      listenAddresses: string[];
      coordinationRelays?: string[];
      expectedTarget?: RuntimeHostManagedServiceTarget;
      allowInterruptActiveTasks?: true;
    }
  | {
      kind: 'runtime-host-service-check-update';
      json: boolean;
      framed?: true;
      clientDataRoot?: string;
      selector: RuntimeHostUpdateSelector;
      expectedTarget?: RuntimeHostManagedServiceTarget;
    }
  | {
      kind: 'runtime-host-service-update';
      json: boolean;
      framed?: true;
      clientDataRoot?: string;
      expectedTarget: RuntimeHostManagedServiceTarget;
      selector?: RuntimeHostUpdateSelector;
      allowInterruptActiveTasks?: true;
    }
  | {
      kind: 'runtime-host-service-update-policy';
      json: boolean;
      framed?: true;
      clientDataRoot?: string;
      policy?: RuntimeHostManagedUpdatePolicy;
      expectedTarget?: RuntimeHostManagedServiceTarget;
    }
  | {
      kind: 'runtime-host-service-reconcile-update';
      json: boolean;
      framed?: true;
      clientDataRoot?: string;
      expectedTarget?: RuntimeHostManagedServiceTarget;
    }
  | {
      kind: 'runtime-host-managed-deployment-cleanup';
      clientDataRoot?: string;
      expectedTarget: RuntimeHostManagedServiceTarget;
    }
  | {
      kind: 'runtime-host-access-issue';
      rootPath?: string;
      expectedRootId?: string;
      principalKind: 'remote_owner' | 'capability_provider';
      principalId: string;
      operationGrants: string[];
      canPublishClientCapabilities: boolean;
      canUseHostPaths: boolean;
      preset?: 'desktop-client' | 'terminal-client';
    }
  | {
      kind: 'runtime-host-access-prepare';
      rootPath?: string;
      expectedRootId?: string;
      currentCredentialFingerprint: string;
    }
  | {
      kind: 'runtime-host-access-list';
      rootPath?: string;
      expectedRootId?: string;
      framed: boolean;
    }
  | {
      kind: 'runtime-host-access-revoke';
      rootPath?: string;
      expectedRootId?: string;
      credentialId: string;
      currentCredentialFingerprint?: string;
      framed: boolean;
    }
  | { kind: 'runtime-host-project-list'; rootPath?: string }
  | {
      kind: 'runtime-host-project-add';
      rootPath?: string;
      path: string;
      prefer: boolean;
    }
  | {
      kind: 'runtime-host-capability-provider-serve';
      url: string;
      mcpConfigPath: string;
      expectedRootId: string;
      credentialEnv?: string;
      clientIdentityPath?: string;
    }
  | { kind: 'runtime-host-profile-list' }
  | {
      kind: 'runtime-host-profile-set';
      id: string;
      name: string;
      transport:
        | { kind: 'tls'; url: string }
        | {
            kind: 'plaintext';
            url: string;
            acknowledgement: 'plaintext-bearer-v1';
          }
        | {
            kind: 'ssh';
            destination: string;
            sshPort?: number;
            remotePort: number;
            websocketPath: string;
          }
        | {
            kind: 'libp2p-direct';
            peerId: string;
            routeHints: string[];
            coordinationRelays: string[];
          };
      expectedRootId: string;
      credentialEnv?: string;
    }
  | { kind: 'runtime-host-profile-remove'; id: string }
  | RuntimeHostCliError;

export function parseRuntimeHostCommand(argv: string[]): RuntimeHostCliCommand {
  if (argv[0] === 'activate') return parseManagedActivationCommand(argv.slice(1));
  if (argv[0] === 'serve') return parseServeCommand(argv.slice(1));
  if (argv[0] === 'setup') return parseSetupCommand(argv.slice(1));
  if (argv[0] === 'service') return parseServiceManagementCommand(argv.slice(1));
  if (argv[0] === 'access') return parseAccessCommand(argv.slice(1));
  if (argv[0] === 'project') return parseProjectCommand(argv.slice(1));
  if (argv[0] === 'capability-provider') {
    return parseCapabilityProviderCommand(argv.slice(1));
  }
  if (argv[0] === 'profile') return parseProfileCommand(argv.slice(1));
  return error(
    argv[0]
      ? `Unexpected runtime-host command: ${argv[0]}`
      : 'runtime-host requires the activate, serve, setup, service, access, project, profile, or capability-provider command',
  );
}

function parseManagedActivationCommand(argv: string[]): RuntimeHostCliCommand {
  let rootId: string | undefined;
  let framed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--framed') {
      if (framed) return error('Duplicate --framed');
      framed = true;
      continue;
    }
    if (argument === '--root-id') {
      if (rootId !== undefined) return error('Duplicate --root-id');
      rootId = argv[index + 1];
      index += 1;
      if (rootId === undefined) return error('--root-id requires a value');
      continue;
    }
    return error(`Unexpected runtime-host activate option: ${String(argument)}`);
  }
  if (!framed) return error('runtime-host activate requires --framed');
  if (!rootId || !/^[a-f0-9]{64}$/u.test(rootId)) {
    return error('runtime-host activate requires a valid --root-id');
  }
  return { kind: 'runtime-host-managed-activate', rootId, framed: true };
}

function parseSetupCommand(argv: string[]): RuntimeHostCliCommand {
  let principalId: string | undefined;
  let preset: 'desktop-client' | 'terminal-client' | undefined;
  let lifecycle: 'supervised' | 'on_demand' = 'supervised';
  let lifecycleProvided = false;
  let deferPairingCommit = false;
  let bindPairingToClient = false;
  let clientDataRoot: string | undefined;
  let enableDirectPeer = false;
  const coordinationRelays: string[] = [];
  const options = parseManagedServiceOptions(argv, {
    valueOptions: {
      '--client-data-root': (value) => {
        if (clientDataRoot !== undefined) return error('Duplicate --client-data-root');
        if (!isSafeAbsolutePath(value)) return error('--client-data-root must be an absolute path');
        clientDataRoot = value;
      },
      '--coordination-relay': (value) => {
        coordinationRelays.push(value);
      },
      '--principal': (value) => {
        principalId = value;
      },
      '--preset': (value) => {
        if (value !== 'desktop-client' && value !== 'terminal-client') {
          return error('--preset must be desktop-client or terminal-client');
        }
        preset = value;
      },
      '--lifecycle': (value) => {
        if (lifecycleProvided) return error('Duplicate --lifecycle');
        if (value !== 'supervised' && value !== 'on-demand') {
          return error('--lifecycle must be supervised or on-demand');
        }
        lifecycleProvided = true;
        lifecycle = value === 'on-demand' ? 'on_demand' : 'supervised';
      },
    },
    flagOptions: {
      '--enable-direct-peer': () => {
        if (enableDirectPeer) return error('Duplicate --enable-direct-peer');
        enableDirectPeer = true;
      },
      '--defer-pairing-commit': () => {
        if (deferPairingCommit) return error('Duplicate --defer-pairing-commit');
        deferPairingCommit = true;
      },
      '--bind-pairing-to-client': () => {
        if (bindPairingToClient) return error('Duplicate --bind-pairing-to-client');
        bindPairingToClient = true;
      },
    },
  });
  if ('kind' in options) return options;
  if (!principalId || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(principalId)) {
    return error('runtime-host setup requires a valid --principal');
  }
  if (!preset) return error('runtime-host setup requires --preset');
  if (!enableDirectPeer && coordinationRelays.length > 0) {
    return error('--coordination-relay requires --enable-direct-peer');
  }
  if (bindPairingToClient && !deferPairingCommit) {
    return error('--bind-pairing-to-client requires --defer-pairing-commit');
  }
  return {
    kind: 'runtime-host-setup',
    ...options,
    principalId,
    preset,
    lifecycle,
    deferPairingCommit,
    ...(bindPairingToClient ? { bindPairingToClient: true } : {}),
    ...(clientDataRoot ? { clientDataRoot } : {}),
    ...(enableDirectPeer ? { directPeer: { coordinationRelays } } : {}),
  };
}

function parseServiceManagementCommand(argv: string[]): RuntimeHostCliCommand {
  const action = argv[0];
  if (action === 'peer') return parseServicePeerCommand(argv.slice(1));
  if (action === 'cleanup-deployment') {
    let clientDataRoot: string | undefined;
    const options = parseManagedServiceOptions(argv.slice(1), {
      allowConfiguration: false,
      valueOptions: {
        '--client-data-root': (value) => {
          if (clientDataRoot !== undefined) return error('Duplicate --client-data-root');
          if (!isSafeAbsolutePath(value))
            return error('--client-data-root must be an absolute path');
          clientDataRoot = value;
        },
      },
    });
    if ('kind' in options) return options;
    if (options.json) return error('Unexpected argument: --json');
    if (!options.expectedTarget) {
      return error('runtime-host service cleanup-deployment requires an expected target');
    }
    return {
      kind: 'runtime-host-managed-deployment-cleanup',
      ...(clientDataRoot ? { clientDataRoot } : {}),
      expectedTarget: options.expectedTarget,
    };
  }
  if (
    action !== 'install' &&
    action !== 'configure' &&
    action !== 'status' &&
    action !== 'start' &&
    action !== 'stop' &&
    action !== 'restart' &&
    action !== 'retire' &&
    action !== 'check-update' &&
    action !== 'update' &&
    action !== 'update-policy' &&
    action !== 'reconcile-update' &&
    action !== 'logs' &&
    action !== 'uninstall'
  ) {
    return error(
      action
        ? `Unexpected runtime-host service command: ${action}`
        : 'runtime-host service requires install, configure, status, start, stop, restart, retire, check-update, update, update-policy, reconcile-update, logs, or uninstall',
    );
  }

  let retainManagedDeployment = false;
  let allowInterruptActiveTasks = false;
  let clientDataRoot: string | undefined;
  let updateTarget: string | undefined;
  let expectedConfigFingerprint: string | undefined;
  const flagOptions: Readonly<Record<string, () => void | RuntimeHostCliError>> =
    action === 'uninstall'
      ? {
          '--retain-managed-deployment': () => {
            if (retainManagedDeployment) return error('Duplicate --retain-managed-deployment');
            retainManagedDeployment = true;
          },
          '--allow-interrupt-active-tasks': () => {
            if (allowInterruptActiveTasks) {
              return error('Duplicate --allow-interrupt-active-tasks');
            }
            allowInterruptActiveTasks = true;
          },
        }
      : action === 'retire' || action === 'update' || action === 'configure'
        ? {
            '--allow-interrupt-active-tasks': () => {
              if (allowInterruptActiveTasks) {
                return error('Duplicate --allow-interrupt-active-tasks');
              }
              allowInterruptActiveTasks = true;
            },
          }
        : {};
  const options = parseManagedServiceOptions(argv.slice(1), {
    allowConfiguration: action === 'install' || action === 'configure',
    allowFramed: true,
    valueOptions: {
      '--client-data-root': (value) => {
        if (clientDataRoot !== undefined) return error('Duplicate --client-data-root');
        if (!isSafeAbsolutePath(value)) return error('--client-data-root must be an absolute path');
        clientDataRoot = value;
      },
      ...(action === 'check-update' || action === 'update' || action === 'update-policy'
        ? {
            '--target': (value: string) => {
              if (updateTarget !== undefined) return error('Duplicate --target');
              updateTarget = value;
            },
          }
        : {}),
      ...(action === 'configure'
        ? {
            '--expected-config-fingerprint': (value: string) => {
              if (expectedConfigFingerprint !== undefined) {
                return error('Duplicate --expected-config-fingerprint');
              }
              if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
                return error(
                  '--expected-config-fingerprint must be a service configuration fingerprint',
                );
              }
              expectedConfigFingerprint = value;
            },
          }
        : {}),
    },
    flagOptions,
  });
  if ('kind' in options) return options;
  if (
    (action === 'retire' ||
      action === 'update' ||
      action === 'configure' ||
      action === 'uninstall') &&
    !options.expectedTarget
  ) {
    return error(`runtime-host service ${action} requires an expected target`);
  }
  if (action === 'configure' && !expectedConfigFingerprint) {
    return error('runtime-host service configure requires --expected-config-fingerprint');
  }
  if (action === 'configure' && options.projectDirectoryRoots === undefined) {
    return error('runtime-host service configure requires --project-root or --no-project-roots');
  }
  if (action === 'update-policy') {
    const policy = updateTarget === undefined ? undefined : parseUpdatePolicy(updateTarget);
    if (policy && 'exitCode' in policy) return policy;
    if (policy && policy.kind !== 'manual' && !options.expectedTarget) {
      return error('runtime-host service update-policy requires an expected target');
    }
    return {
      kind: 'runtime-host-service-update-policy',
      json: options.json,
      ...(options.framed ? { framed: true } : {}),
      ...(clientDataRoot ? { clientDataRoot } : {}),
      ...(policy ? { policy } : {}),
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    };
  }
  if (action === 'reconcile-update') {
    return {
      kind: 'runtime-host-service-reconcile-update',
      json: options.json,
      ...(options.framed ? { framed: true } : {}),
      ...(clientDataRoot ? { clientDataRoot } : {}),
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    };
  }
  if (action === 'check-update') {
    const selector = parseUpdateSelector(updateTarget);
    if ('kind' in selector && selector.kind === 'error') return selector;
    return {
      kind: 'runtime-host-service-check-update',
      json: options.json,
      ...(options.framed ? { framed: true } : {}),
      ...(clientDataRoot ? { clientDataRoot } : {}),
      selector,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    };
  }
  if (action === 'update') {
    const selector =
      updateTarget === undefined ? undefined : parseUpdateSelector(updateTarget, 'update');
    if (selector && 'kind' in selector && selector.kind === 'error') return selector;
    return {
      kind: 'runtime-host-service-update',
      json: options.json,
      ...(options.framed ? { framed: true } : {}),
      ...(clientDataRoot ? { clientDataRoot } : {}),
      expectedTarget: options.expectedTarget!,
      ...(selector ? { selector } : {}),
      ...(allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
    };
  }
  return {
    kind: 'runtime-host-service-manage',
    action,
    ...options,
    ...(clientDataRoot ? { clientDataRoot } : {}),
    ...(retainManagedDeployment ? { retainManagedDeployment: true } : {}),
    ...(allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
    ...(action === 'configure'
      ? {
          expectedConfigFingerprint: expectedConfigFingerprint!,
          projectDirectoryRoots: options.projectDirectoryRoots!,
        }
      : {}),
  };
}

function parseServicePeerCommand(argv: string[]): RuntimeHostCliCommand {
  const action = argv[0];
  if (
    action !== 'enable' &&
    action !== 'disable' &&
    action !== 'status' &&
    action !== 'rotate' &&
    action !== 'descriptor'
  ) {
    return error(
      action
        ? `Unexpected runtime-host service peer command: ${action}`
        : 'runtime-host service peer requires enable, disable, status, rotate, or descriptor',
    );
  }
  let clientDataRoot: string | undefined;
  const listenAddresses: string[] = [];
  const coordinationRelays: string[] = [];
  let clearCoordinationRelays = false;
  let allowInterruptActiveTasks = false;
  const options = parseManagedServiceOptions(argv.slice(1), {
    allowConfiguration: false,
    allowFramed: true,
    flagOptions: {
      '--clear-coordination-relays': () => {
        if (clearCoordinationRelays) return error('Duplicate --clear-coordination-relays');
        clearCoordinationRelays = true;
      },
      '--allow-interrupt-active-tasks': () => {
        if (allowInterruptActiveTasks) return error('Duplicate --allow-interrupt-active-tasks');
        allowInterruptActiveTasks = true;
      },
    },
    valueOptions: {
      '--client-data-root': (value) => {
        if (clientDataRoot !== undefined) return error('Duplicate --client-data-root');
        if (!isSafeAbsolutePath(value)) return error('--client-data-root must be an absolute path');
        clientDataRoot = value;
      },
      '--listen': (value) => {
        listenAddresses.push(value);
      },
      '--coordination-relay': (value) => {
        coordinationRelays.push(value);
      },
    },
  });
  if ('kind' in options) return options;
  if (options.framed && (action === 'rotate' || action === 'descriptor')) {
    return error(`runtime-host service peer ${action} does not support --framed`);
  }
  if (listenAddresses.some(hasEphemeralRuntimeHostPeerPort)) {
    return error('--listen requires a stable non-zero transport port');
  }
  if (clearCoordinationRelays && coordinationRelays.length > 0) {
    return error('--clear-coordination-relays cannot be combined with --coordination-relay');
  }
  if (
    action !== 'enable' &&
    (listenAddresses.length > 0 || coordinationRelays.length > 0 || clearCoordinationRelays)
  ) {
    return error(
      '--listen, --coordination-relay, and --clear-coordination-relays are only valid with peer enable',
    );
  }
  if (allowInterruptActiveTasks && action !== 'enable' && action !== 'disable') {
    return error('--allow-interrupt-active-tasks is only valid with peer enable or peer disable');
  }
  if (
    (action === 'enable' ||
      action === 'disable' ||
      action === 'rotate' ||
      action === 'descriptor') &&
    !options.expectedTarget
  ) {
    return error(`runtime-host service peer ${action} requires an expected target`);
  }
  return {
    kind: 'runtime-host-service-peer',
    action,
    json: options.json,
    ...(options.framed ? { framed: true as const } : {}),
    ...(clientDataRoot ? { clientDataRoot } : {}),
    listenAddresses,
    ...(clearCoordinationRelays
      ? { coordinationRelays: [] }
      : coordinationRelays.length > 0
        ? { coordinationRelays }
        : {}),
    ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    ...(allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
  };
}

function parseUpdatePolicy(value: string): RuntimeHostManagedUpdatePolicy | RuntimeHostCliError {
  if (value === 'manual') return { kind: 'manual' };
  const selector = parseUpdateSelector(value, 'update-policy');
  if ('exitCode' in selector) return selector;
  return selector.kind === 'exact' ? { kind: 'fixed', version: selector.version } : selector;
}

function parseUpdateSelector(
  value: string | undefined,
  action: 'check-update' | 'update' | 'update-policy' = 'check-update',
): RuntimeHostUpdateSelector | RuntimeHostCliError {
  if (!value) return error(`runtime-host service ${action} requires --target`);
  if (value === 'latest' || value === 'next') {
    return { kind: 'channel', channel: value };
  }
  if (!isProductReleaseVersion(value)) {
    return error('--target must be latest, next, or an exact Maka version');
  }
  return { kind: 'exact', version: value };
}

interface ManagedServiceOptions {
  readonly json: boolean;
  readonly framed?: true;
  readonly rootPath?: string;
  readonly projectDirectoryRoots?: {
    readonly label: string;
    readonly path: string;
  }[];
  readonly websocketPort?: number;
  readonly websocketPath?: string;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
}

function parseManagedServiceOptions(
  argv: string[],
  input: {
    readonly valueOptions?: Readonly<Record<string, (value: string) => RuntimeHostCliError | void>>;
    readonly flagOptions?: Readonly<Record<string, () => RuntimeHostCliError | void>>;
    readonly allowConfiguration?: boolean;
    readonly allowFramed?: boolean;
  } = {},
): ManagedServiceOptions | RuntimeHostCliError {
  let json = false;
  let framed = false;
  let rootPath: string | undefined;
  let websocketPort: number | undefined;
  let websocketPath: string | undefined;
  let expectedServiceId: string | undefined;
  let expectedRootPath: string | undefined;
  let expectedRootId: string | undefined;
  let projectDirectoryPolicySpecified = false;
  const projectDirectoryRoots: { label: string; path: string }[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      if (json) return error('Duplicate --json');
      if (framed) return error('--json and --framed cannot be used together');
      json = true;
      continue;
    }
    if (argument === '--framed') {
      if (!input.allowFramed) return error(`Unexpected argument: ${argument}`);
      if (framed) return error('Duplicate --framed');
      if (json) return error('--json and --framed cannot be used together');
      framed = true;
      continue;
    }
    if (Object.hasOwn(input.flagOptions ?? {}, argument ?? '')) {
      const optionError = input.flagOptions?.[argument ?? '']?.();
      if (optionError) return optionError;
      continue;
    }
    if (argument === '--no-project-roots') {
      if (input.allowConfiguration === false) return error(`Unexpected argument: ${argument}`);
      if (projectDirectoryPolicySpecified) {
        return error('--no-project-roots cannot be combined with --project-root');
      }
      projectDirectoryPolicySpecified = true;
      continue;
    }
    const isTargetOption =
      argument === '--expected-service-id' ||
      argument === '--expected-root-path' ||
      argument === '--expected-root-id';
    const isExplicitlyAllowedOption = Object.hasOwn(input.valueOptions ?? {}, argument ?? '');
    if (input.allowConfiguration === false && !isTargetOption && !isExplicitlyAllowedOption) {
      return error(`Unexpected argument: ${argument ?? ''}`);
    }
    if (
      argument === '--root' ||
      argument === '--websocket-port' ||
      argument === '--websocket-path' ||
      argument === '--project-root' ||
      argument === '--project-root-json' ||
      argument === '--expected-service-id' ||
      argument === '--expected-root-path' ||
      argument === '--expected-root-id' ||
      Object.hasOwn(input.valueOptions ?? {}, argument ?? '')
    ) {
      const parsed = optionValue(argv, index, argument ?? '');
      if (typeof parsed !== 'string') return parsed;
      if (argument === '--root') rootPath = parsed;
      else if (argument === '--websocket-port') websocketPort = Number(parsed);
      else if (argument === '--websocket-path') websocketPath = parsed;
      else if (argument === '--expected-service-id') expectedServiceId = parsed;
      else if (argument === '--expected-root-path') expectedRootPath = parsed;
      else if (argument === '--expected-root-id') expectedRootId = parsed;
      else if (argument === '--project-root' || argument === '--project-root-json') {
        if (projectDirectoryPolicySpecified && projectDirectoryRoots.length === 0) {
          return error('--project-root cannot be combined with --no-project-roots');
        }
        projectDirectoryPolicySpecified = true;
        const root =
          argument === '--project-root'
            ? parseProjectRoot(parsed, 'posix')
            : parseProjectRootJson(parsed, 'posix');
        if ('kind' in root) return root;
        if (projectDirectoryRoots.length >= PROJECT_DIRECTORY_MAX_ROOTS) {
          return error(
            `--project-root may be provided at most ${PROJECT_DIRECTORY_MAX_ROOTS} times`,
          );
        }
        if (projectDirectoryRoots.some((candidate) => candidate.label === root.label)) {
          return error(`Duplicate --project-root label: ${root.label}`);
        }
        projectDirectoryRoots.push(root);
      } else {
        const optionError = input.valueOptions?.[argument ?? '']?.(parsed);
        if (optionError) return optionError;
      }
      index += 1;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (
    websocketPort !== undefined &&
    (!Number.isInteger(websocketPort) || websocketPort < 1 || websocketPort > 65_535)
  ) {
    return error('--websocket-port must be an integer between 1 and 65535');
  }
  if (websocketPath !== undefined && !isCanonicalRuntimeHostWebSocketPath(websocketPath)) {
    return error('--websocket-path must be a canonical absolute URL path');
  }
  if (expectedServiceId !== undefined && !/^[a-f0-9]{64}$/u.test(expectedServiceId)) {
    return error('--expected-service-id must be a Runtime Host managed service identity');
  }
  if (expectedRootId !== undefined && !/^[a-f0-9]{64}$/u.test(expectedRootId)) {
    return error('--expected-root-id must be a Runtime Host State Root identity');
  }
  if (
    expectedRootPath !== undefined &&
    (expectedRootPath.length === 0 ||
      Buffer.byteLength(expectedRootPath, 'utf8') > 4 * 1024 ||
      /[\u0000-\u001f\u007f]/u.test(expectedRootPath))
  ) {
    return error('--expected-root-path is invalid');
  }
  const hasExpectedTarget =
    expectedServiceId !== undefined ||
    expectedRootPath !== undefined ||
    expectedRootId !== undefined;
  if (hasExpectedTarget && (!expectedServiceId || !expectedRootPath || !expectedRootId)) {
    return error(
      '--expected-service-id, --expected-root-path, and --expected-root-id must be provided together',
    );
  }
  return {
    json,
    ...(framed ? { framed: true as const } : {}),
    ...(rootPath ? { rootPath } : {}),
    ...(projectDirectoryPolicySpecified ? { projectDirectoryRoots } : {}),
    ...(websocketPort === undefined ? {} : { websocketPort }),
    ...(websocketPath === undefined ? {} : { websocketPath }),
    ...(expectedServiceId === undefined
      ? {}
      : {
          expectedTarget: {
            serviceId: expectedServiceId,
            rootPath: expectedRootPath!,
            rootId: expectedRootId!,
          },
        }),
  };
}

function isSafeAbsolutePath(value: string): boolean {
  return isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseProjectCommand(argv: string[]): RuntimeHostCliCommand {
  const action = argv[0];
  if (action !== 'list' && action !== 'add') {
    return error(
      action
        ? `Unexpected runtime-host project command: ${action}`
        : 'runtime-host project requires the list or add command',
    );
  }
  let rootPath: string | undefined;
  let path: string | undefined;
  let prefer = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      rootPath = parsed;
      index += 1;
      continue;
    }
    if (action === 'add' && argument === '--prefer') {
      prefer = true;
      continue;
    }
    if (action === 'add' && path === undefined) {
      path = argument;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (action === 'list') {
    return {
      kind: 'runtime-host-project-list',
      ...(rootPath ? { rootPath } : {}),
    };
  }
  if (!path) return error('runtime-host project add requires a path');
  return {
    kind: 'runtime-host-project-add',
    path,
    prefer,
    ...(rootPath ? { rootPath } : {}),
  };
}

function parseProfileCommand(argv: string[]): RuntimeHostCliCommand {
  const action = argv[0];
  if (action === 'list') {
    return argv.length === 1
      ? { kind: 'runtime-host-profile-list' }
      : error(`Unexpected argument: ${argv[1] ?? ''}`);
  }
  if (action === 'remove') {
    if (argv[1] !== '--id') return error('runtime-host profile remove requires --id');
    const id = optionValue(argv, 1, '--id');
    if (typeof id !== 'string') return id;
    return argv.length === 3
      ? { kind: 'runtime-host-profile-remove', id }
      : error(`Unexpected argument: ${argv[3] ?? ''}`);
  }
  if (action !== 'set') {
    return error(
      action
        ? `Unexpected runtime-host profile command: ${action}`
        : 'runtime-host profile requires the list, set, or remove command',
    );
  }
  let id: string | undefined;
  let name: string | undefined;
  let tlsUrl: string | undefined;
  let plaintextUrl: string | undefined;
  let acknowledgePlaintext = false;
  let sshDestination: string | undefined;
  let sshPort: number | undefined;
  let sshRemotePort: number | undefined;
  let sshWebSocketPath = '/runtime-host';
  let sshWebSocketPathConfigured = false;
  let peerId: string | undefined;
  const peerRouteHints: string[] = [];
  const peerCoordinationRelays: string[] = [];
  let expectedRootId: string | undefined;
  let credentialEnv: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument !== '--id' &&
      argument !== '--name' &&
      argument !== '--tls-url' &&
      argument !== '--plaintext-url' &&
      argument !== '--ssh-destination' &&
      argument !== '--ssh-port' &&
      argument !== '--ssh-remote-port' &&
      argument !== '--ssh-websocket-path' &&
      argument !== '--peer-id' &&
      argument !== '--peer-route' &&
      argument !== '--peer-coordination-relay' &&
      argument !== '--expected-root' &&
      argument !== '--credential-env' &&
      argument !== '--acknowledge-plaintext'
    ) {
      return error(`Unexpected argument: ${argument ?? ''}`);
    }
    if (argument === '--acknowledge-plaintext') {
      acknowledgePlaintext = true;
      continue;
    }
    const parsed = optionValue(argv, index, argument);
    if (typeof parsed !== 'string') return parsed;
    if (argument === '--id') id = parsed;
    if (argument === '--name') name = parsed;
    if (argument === '--tls-url') tlsUrl = parsed;
    if (argument === '--plaintext-url') plaintextUrl = parsed;
    if (argument === '--ssh-destination') sshDestination = parsed;
    if (argument === '--ssh-port') sshPort = Number(parsed);
    if (argument === '--ssh-remote-port') sshRemotePort = Number(parsed);
    if (argument === '--ssh-websocket-path') {
      sshWebSocketPath = parsed;
      sshWebSocketPathConfigured = true;
    }
    if (argument === '--peer-id') peerId = parsed;
    if (argument === '--peer-route') peerRouteHints.push(parsed);
    if (argument === '--peer-coordination-relay') peerCoordinationRelays.push(parsed);
    if (argument === '--expected-root') expectedRootId = parsed;
    if (argument === '--credential-env') credentialEnv = parsed;
    index += 1;
  }
  if (!id) return error('--id is required');
  if (!name) return error('--name is required');
  if (
    (tlsUrl ? 1 : 0) + (plaintextUrl ? 1 : 0) + (sshDestination ? 1 : 0) + (peerId ? 1 : 0) !==
    1
  ) {
    return error(
      'exactly one of --tls-url, --plaintext-url, --ssh-destination, or --peer-id is required',
    );
  }
  if (plaintextUrl && !acknowledgePlaintext) {
    return error('--plaintext-url requires --acknowledge-plaintext');
  }
  if (!plaintextUrl && acknowledgePlaintext) {
    return error('--acknowledge-plaintext requires --plaintext-url');
  }
  if (
    !sshDestination &&
    (sshPort !== undefined || sshRemotePort !== undefined || sshWebSocketPathConfigured)
  ) {
    return error('SSH options require --ssh-destination');
  }
  if (sshDestination && !sshRemotePort) {
    return error('--ssh-destination requires --ssh-remote-port');
  }
  if (!peerId && (peerRouteHints.length > 0 || peerCoordinationRelays.length > 0)) {
    return error('peer route options require --peer-id');
  }
  if (peerId && peerRouteHints.length === 0 && peerCoordinationRelays.length === 0) {
    return error('--peer-id requires at least one --peer-route or --peer-coordination-relay');
  }
  if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65_535)) {
    return error('--ssh-port must be an integer between 1 and 65535');
  }
  if (
    sshRemotePort !== undefined &&
    (!Number.isInteger(sshRemotePort) || sshRemotePort < 1 || sshRemotePort > 65_535)
  ) {
    return error('--ssh-remote-port must be an integer between 1 and 65535');
  }
  if (!expectedRootId) return error('--expected-root is required');
  return {
    kind: 'runtime-host-profile-set',
    id,
    name,
    transport: tlsUrl
      ? { kind: 'tls', url: tlsUrl }
      : plaintextUrl
        ? {
            kind: 'plaintext',
            url: plaintextUrl,
            acknowledgement: 'plaintext-bearer-v1',
          }
        : sshDestination
          ? {
              kind: 'ssh',
              destination: sshDestination,
              ...(sshPort === undefined ? {} : { sshPort }),
              remotePort: sshRemotePort!,
              websocketPath: sshWebSocketPath,
            }
          : {
              kind: 'libp2p-direct',
              peerId: peerId!,
              routeHints: peerRouteHints,
              coordinationRelays: peerCoordinationRelays,
            },
    expectedRootId,
    ...(credentialEnv ? { credentialEnv } : {}),
  };
}

function parseCapabilityProviderCommand(argv: string[]): RuntimeHostCliCommand {
  if (argv[0] !== 'serve') {
    return error(
      argv[0]
        ? `Unexpected runtime-host capability-provider command: ${argv[0]}`
        : 'runtime-host capability-provider requires the serve command',
    );
  }
  let url: string | undefined;
  let mcpConfigPath: string | undefined;
  let expectedRootId: string | undefined;
  let credentialEnv: string | undefined;
  let clientIdentityPath: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === '--url' ||
      argument === '--mcp-config' ||
      argument === '--expected-root' ||
      argument === '--credential-env' ||
      argument === '--client-identity'
    ) {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      if (argument === '--url') url = parsed;
      if (argument === '--mcp-config') mcpConfigPath = parsed;
      if (argument === '--expected-root') expectedRootId = parsed;
      if (argument === '--credential-env') credentialEnv = parsed;
      if (argument === '--client-identity') clientIdentityPath = parsed;
      index += 1;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (!url) return error('--url is required');
  if (!mcpConfigPath) return error('--mcp-config is required');
  if (!expectedRootId) return error('--expected-root is required');
  return {
    kind: 'runtime-host-capability-provider-serve',
    url,
    mcpConfigPath,
    expectedRootId,
    ...(credentialEnv ? { credentialEnv } : {}),
    ...(clientIdentityPath ? { clientIdentityPath } : {}),
  };
}

function parseServeCommand(argv: string[]): RuntimeHostCliCommand {
  let rootPath: string | undefined;
  let managedServiceConfigPath: string | undefined;
  let json = false;
  let websocketHost = '127.0.0.1';
  let websocketConfigured = false;
  let websocketPort: number | undefined;
  let websocketPath: string | undefined;
  let tlsCertificatePath: string | undefined;
  let tlsPrivateKeyPath: string | undefined;
  let allowInsecureRemote = false;
  let peerNativePath: string | undefined;
  let peerKeyPath: string | undefined;
  let peerId: string | undefined;
  const allowedOrigins: string[] = [];
  const peerListenAddresses: string[] = [];
  const peerCoordinationRelays: string[] = [];
  const projectDirectoryRoots: { label: string; path: string }[] = [];
  let projectDirectoryPolicySpecified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--allow-insecure-remote') {
      allowInsecureRemote = true;
      websocketConfigured = true;
      continue;
    }
    if (argument === '--root') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      rootPath = parsed;
      index += 1;
      continue;
    }
    if (argument === '--managed-service-config') {
      if (managedServiceConfigPath !== undefined) {
        return error('Duplicate --managed-service-config');
      }
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      if (!isSafeAbsolutePath(parsed)) {
        return error('--managed-service-config must be an absolute path');
      }
      managedServiceConfigPath = parsed;
      index += 1;
      continue;
    }
    if (argument === '--project-root' || argument === '--project-root-json') {
      if (projectDirectoryPolicySpecified && projectDirectoryRoots.length === 0) {
        return error('--project-root cannot be combined with --no-project-roots');
      }
      projectDirectoryPolicySpecified = true;
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      const root =
        argument === '--project-root'
          ? parseProjectRoot(parsed, 'native')
          : parseProjectRootJson(parsed, 'native');
      if ('kind' in root) return root;
      if (projectDirectoryRoots.length >= PROJECT_DIRECTORY_MAX_ROOTS) {
        return error(`--project-root may be provided at most ${PROJECT_DIRECTORY_MAX_ROOTS} times`);
      }
      if (projectDirectoryRoots.some((candidate) => candidate.label === root.label)) {
        return error(`Duplicate --project-root label: ${root.label}`);
      }
      projectDirectoryRoots.push(root);
      index += 1;
      continue;
    }
    if (argument === '--no-project-roots') {
      if (projectDirectoryPolicySpecified) {
        return error('--no-project-roots cannot be combined with --project-root');
      }
      projectDirectoryPolicySpecified = true;
      continue;
    }
    if (argument === '--websocket-host') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      websocketHost = parsed;
      websocketConfigured = true;
      index += 1;
      continue;
    }
    if (argument === '--websocket-port') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      websocketPort = Number(parsed);
      websocketConfigured = true;
      if (!Number.isInteger(websocketPort) || websocketPort < 1 || websocketPort > 65_535) {
        return error('--websocket-port must be an integer between 1 and 65535');
      }
      index += 1;
      continue;
    }
    if (argument === '--websocket-path') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      websocketPath = parsed;
      websocketConfigured = true;
      index += 1;
      continue;
    }
    if (argument === '--tls-certificate' || argument === '--tls-private-key') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      if (argument === '--tls-certificate') tlsCertificatePath = parsed;
      else tlsPrivateKeyPath = parsed;
      websocketConfigured = true;
      index += 1;
      continue;
    }
    if (argument === '--allow-origin') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      allowedOrigins.push(parsed);
      websocketConfigured = true;
      index += 1;
      continue;
    }
    if (
      argument === '--peer-native-path' ||
      argument === '--peer-key' ||
      argument === '--peer-id' ||
      argument === '--peer-listen' ||
      argument === '--peer-coordination-relay'
    ) {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      if (argument === '--peer-native-path') peerNativePath = parsed;
      if (argument === '--peer-key') peerKeyPath = parsed;
      if (argument === '--peer-id') peerId = parsed;
      if (argument === '--peer-listen') peerListenAddresses.push(parsed);
      if (argument === '--peer-coordination-relay') peerCoordinationRelays.push(parsed);
      index += 1;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if ((tlsCertificatePath === undefined) !== (tlsPrivateKeyPath === undefined)) {
    return error('--tls-certificate and --tls-private-key must be provided together');
  }
  if (allowInsecureRemote && tlsCertificatePath !== undefined) {
    return error('--allow-insecure-remote cannot be combined with TLS');
  }
  if (websocketConfigured && websocketPort === undefined) {
    return error('--websocket-port is required for WebSocket options');
  }
  if (websocketPath !== undefined && !isCanonicalRuntimeHostWebSocketPath(websocketPath)) {
    return error('--websocket-path must be a canonical absolute URL path');
  }
  if ((peerNativePath === undefined) !== (peerKeyPath === undefined)) {
    return error('--peer-native-path and --peer-key must be provided together');
  }
  if (
    peerNativePath === undefined &&
    (peerId !== undefined || peerListenAddresses.length > 0 || peerCoordinationRelays.length > 0)
  ) {
    return error('peer listener options require --peer-native-path and --peer-key');
  }
  if (
    managedServiceConfigPath !== undefined &&
    (rootPath !== undefined ||
      projectDirectoryPolicySpecified ||
      websocketConfigured ||
      peerNativePath !== undefined)
  ) {
    return error('--managed-service-config cannot be combined with Runtime Host settings');
  }
  return {
    kind: 'runtime-host-serve',
    json,
    ...(managedServiceConfigPath ? { managedServiceConfigPath } : {}),
    ...(rootPath ? { rootPath } : {}),
    ...(projectDirectoryPolicySpecified ? { projectDirectoryRoots } : {}),
    ...(websocketPort === undefined
      ? {}
      : {
          websocket: {
            host: websocketHost,
            port: websocketPort,
            ...(websocketPath ? { path: websocketPath } : {}),
            ...(tlsCertificatePath ? { tlsCertificatePath } : {}),
            ...(tlsPrivateKeyPath ? { tlsPrivateKeyPath } : {}),
            ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
            ...(allowInsecureRemote ? { allowInsecureRemote: true } : {}),
          },
        }),
    ...(peerNativePath === undefined
      ? {}
      : {
          peer: {
            nativePath: peerNativePath,
            keyPath: peerKeyPath!,
            ...(peerId ? { expectedPeerId: peerId } : {}),
            ...(peerListenAddresses.length > 0 ? { listenAddresses: peerListenAddresses } : {}),
            ...(peerCoordinationRelays.length > 0
              ? { coordinationRelays: peerCoordinationRelays }
              : {}),
          },
        }),
  };
}

function parseProjectRoot(
  value: string,
  pathKind: 'native' | 'posix',
): { label: string; path: string } | RuntimeHostCliError {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    return error('--project-root must use <label>=<absolute-path>');
  }
  const root = canonicalProjectDirectoryRootSpec({
    label: value.slice(0, separator),
    path: value.slice(separator + 1),
  });
  if (!projectRootValid(root, pathKind)) {
    return error(
      `--project-root must use a valid label and absolute ${pathKind === 'posix' ? 'POSIX' : 'Host'} path`,
    );
  }
  return root;
}

function parseProjectRootJson(
  value: string,
  pathKind: 'native' | 'posix',
): { label: string; path: string } | RuntimeHostCliError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return error('--project-root-json must be a JSON object with label and path');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return error('--project-root-json must be a JSON object with label and path');
  }
  const root = parsed as Record<string, unknown>;
  if (
    Object.keys(root).length !== 2 ||
    typeof root.label !== 'string' ||
    typeof root.path !== 'string'
  ) {
    return error('--project-root-json must be a JSON object with label and path');
  }
  const canonical = canonicalProjectDirectoryRootSpec({ label: root.label, path: root.path });
  if (!projectRootValid(canonical, pathKind)) {
    return error(
      `--project-root-json must use a valid label and absolute ${pathKind === 'posix' ? 'POSIX' : 'Host'} path`,
    );
  }
  return canonical;
}

function projectRootValid(
  root: { readonly label: string; readonly path: string },
  pathKind: 'native' | 'posix',
): boolean {
  return pathKind === 'posix'
    ? projectDirectoryPosixRootSpecValid(root)
    : projectDirectoryRootSpecValid(root) && isAbsolute(root.path);
}

function parseAccessCommand(argv: string[]): RuntimeHostCliCommand {
  const action = argv[0];
  if (action !== 'list' && action !== 'issue' && action !== 'prepare' && action !== 'revoke') {
    return error(
      action
        ? `Unexpected runtime-host access command: ${action}`
        : 'runtime-host access requires list, issue, prepare, or revoke',
    );
  }
  let rootPath: string | undefined;
  let expectedRootId: string | undefined;
  let framed = false;
  let principalId: string | undefined;
  let principalKind: 'remote_owner' | 'capability_provider' = 'remote_owner';
  let principalKindSpecified = false;
  let credentialId: string | undefined;
  let currentCredentialFingerprint: string | undefined;
  const operationGrants: string[] = [];
  let canPublishClientCapabilities = false;
  let canUseHostPaths = false;
  let preset: 'desktop-client' | 'terminal-client' | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--framed') {
      if (framed) return error('Duplicate --framed');
      framed = true;
      continue;
    }
    if (argument === '--publish-client-capabilities') {
      canPublishClientCapabilities = true;
      continue;
    }
    if (argument === '--allow-host-paths') {
      canUseHostPaths = true;
      continue;
    }
    if (
      argument === '--root' ||
      argument === '--expected-root' ||
      argument === '--kind' ||
      argument === '--preset' ||
      argument === '--principal' ||
      argument === '--grant' ||
      argument === '--credential' ||
      argument === '--current-fingerprint'
    ) {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      if (argument === '--root') rootPath = parsed;
      if (argument === '--expected-root') expectedRootId = parsed;
      if (argument === '--kind') {
        if (parsed !== 'remote-owner' && parsed !== 'capability-provider') {
          return error('--kind must be remote-owner or capability-provider');
        }
        principalKind = parsed === 'remote-owner' ? 'remote_owner' : 'capability_provider';
        principalKindSpecified = true;
      }
      if (argument === '--preset') {
        if (parsed !== 'desktop-client' && parsed !== 'terminal-client') {
          return error('--preset must be desktop-client or terminal-client');
        }
        preset = parsed;
      }
      if (argument === '--principal') principalId = parsed;
      if (argument === '--grant') operationGrants.push(parsed);
      if (argument === '--credential') credentialId = parsed;
      if (argument === '--current-fingerprint') currentCredentialFingerprint = parsed;
      index += 1;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (expectedRootId && !/^[a-f0-9]{64}$/u.test(expectedRootId)) {
    return error('--expected-root must be a Runtime Host root identity');
  }
  if (action === 'list') {
    if (
      principalId ||
      principalKindSpecified ||
      operationGrants.length > 0 ||
      canPublishClientCapabilities ||
      canUseHostPaths ||
      preset ||
      credentialId ||
      currentCredentialFingerprint
    ) {
      return error('Credential mutation options are not valid for access list');
    }
    return {
      kind: 'runtime-host-access-list',
      ...(rootPath ? { rootPath } : {}),
      ...(expectedRootId ? { expectedRootId } : {}),
      framed,
    };
  }
  if (action === 'prepare') {
    if (!framed) return error('access prepare is reserved for framed operator management');
    if (!currentCredentialFingerprint) return error('--current-fingerprint is required');
    if (!/^[a-f0-9]{32}$/u.test(currentCredentialFingerprint)) {
      return error('--current-fingerprint must be a Runtime Host credential fingerprint');
    }
    if (
      principalId ||
      principalKindSpecified ||
      operationGrants.length > 0 ||
      canPublishClientCapabilities ||
      canUseHostPaths ||
      preset ||
      credentialId
    ) {
      return error('Credential issue options are not valid for access prepare');
    }
    return {
      kind: 'runtime-host-access-prepare',
      ...(rootPath ? { rootPath } : {}),
      ...(expectedRootId ? { expectedRootId } : {}),
      currentCredentialFingerprint,
    };
  }
  if (action === 'issue') {
    if (framed) return error('--framed is only valid for access management');
    if (!principalId) return error('--principal is required');
    if (credentialId || currentCredentialFingerprint) {
      return error('Credential target options are only valid for access revoke');
    }
    if (
      preset &&
      (principalKindSpecified ||
        operationGrants.length > 0 ||
        canPublishClientCapabilities ||
        canUseHostPaths)
    ) {
      return error('--preset cannot be combined with --kind, --grant, or authority flags');
    }
    if (preset) {
      return {
        kind: 'runtime-host-access-issue',
        ...(rootPath ? { rootPath } : {}),
        ...(expectedRootId ? { expectedRootId } : {}),
        principalKind: 'remote_owner',
        principalId,
        operationGrants,
        canPublishClientCapabilities: false,
        canUseHostPaths: false,
        preset,
      };
    }
    if (principalKind === 'capability_provider') {
      const requiredGrants = ['client.capability.replace', 'client.capability.unregister'];
      if (canUseHostPaths) return error('A capability provider cannot use Host paths');
      if (operationGrants.length === 0) operationGrants.push(...requiredGrants);
      if (
        operationGrants.length !== requiredGrants.length ||
        requiredGrants.some((grant) => !operationGrants.includes(grant))
      ) {
        return error('A capability provider may grant only Client Capability publication');
      }
      canPublishClientCapabilities = true;
    } else if (operationGrants.length === 0) {
      return error('At least one --grant is required');
    }
    return {
      kind: 'runtime-host-access-issue',
      ...(rootPath ? { rootPath } : {}),
      ...(expectedRootId ? { expectedRootId } : {}),
      principalKind,
      principalId,
      operationGrants,
      canPublishClientCapabilities,
      canUseHostPaths,
    };
  }
  if (!credentialId) return error('--credential is required');
  if (framed && !currentCredentialFingerprint) {
    return error('--current-fingerprint is required for framed access revoke');
  }
  if (currentCredentialFingerprint && !/^[a-f0-9]{32}$/u.test(currentCredentialFingerprint)) {
    return error('--current-fingerprint must be a Runtime Host credential fingerprint');
  }
  if (
    principalId ||
    principalKindSpecified ||
    operationGrants.length > 0 ||
    canPublishClientCapabilities ||
    canUseHostPaths ||
    preset
  ) {
    return error('Issue-only access options are not valid for revoke');
  }
  return {
    kind: 'runtime-host-access-revoke',
    ...(rootPath ? { rootPath } : {}),
    ...(expectedRootId ? { expectedRootId } : {}),
    credentialId,
    ...(currentCredentialFingerprint ? { currentCredentialFingerprint } : {}),
    framed,
  };
}

function optionValue(argv: string[], index: number, option: string): string | RuntimeHostCliError {
  const value = argv[index + 1];
  return !value || value.startsWith('-') ? error(`${option} requires a value`) : value;
}

function error(message: string): RuntimeHostCliError {
  return { kind: 'error', message, exitCode: 2 };
}

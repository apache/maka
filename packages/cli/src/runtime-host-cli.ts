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
import {
  isCanonicalRuntimeHostWebSocketPath,
  PROJECT_DIRECTORY_MAX_ROOTS,
  PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES,
} from '@maka/runtime-host/protocol';
import type { RuntimeHostManagedServiceTarget } from './runtime-host-service-manager.js';

type RuntimeHostCliError = { kind: 'error'; message: string; exitCode: number };

export type RuntimeHostCliCommand =
  | {
      kind: 'runtime-host-serve';
      rootPath?: string;
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
    }
  | {
      kind: 'runtime-host-setup';
      json: boolean;
      principalId: string;
      preset: 'desktop-client' | 'terminal-client';
      deferPairingCommit: boolean;
      rootPath?: string;
      projectDirectoryRoots?: { label: string; path: string }[];
      websocketPort?: number;
      websocketPath?: string;
      expectedTarget?: RuntimeHostManagedServiceTarget;
    }
  | {
      kind: 'runtime-host-service-manage';
      action: 'install' | 'status' | 'start' | 'stop' | 'restart' | 'logs' | 'uninstall';
      json: boolean;
      framed?: true;
      clientDataRoot?: string;
      rootPath?: string;
      projectDirectoryRoots?: { label: string; path: string }[];
      websocketPort?: number;
      websocketPath?: string;
      expectedTarget?: RuntimeHostManagedServiceTarget;
      retainManagedDeployment?: true;
    }
  | {
      kind: 'runtime-host-access-issue';
      rootPath?: string;
      principalKind: 'remote_owner' | 'capability_provider';
      principalId: string;
      operationGrants: string[];
      canPublishClientCapabilities: boolean;
      canUseHostPaths: boolean;
      preset?: 'desktop-client' | 'terminal-client';
    }
  | { kind: 'runtime-host-access-revoke'; rootPath?: string; credentialId: string }
  | { kind: 'runtime-host-project-list'; rootPath?: string }
  | { kind: 'runtime-host-project-add'; rootPath?: string; path: string }
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
          };
      expectedRootId: string;
      credentialEnv?: string;
    }
  | { kind: 'runtime-host-profile-remove'; id: string }
  | RuntimeHostCliError;

export function parseRuntimeHostCommand(argv: string[]): RuntimeHostCliCommand {
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
      : 'runtime-host requires the serve, setup, service, access, project, profile, or capability-provider command',
  );
}

function parseSetupCommand(argv: string[]): RuntimeHostCliCommand {
  let principalId: string | undefined;
  let preset: 'desktop-client' | 'terminal-client' | undefined;
  let deferPairingCommit = false;
  const options = parseManagedServiceOptions(argv, {
    valueOptions: {
      '--principal': (value) => {
        principalId = value;
      },
      '--preset': (value) => {
        if (value !== 'desktop-client' && value !== 'terminal-client') {
          return error('--preset must be desktop-client or terminal-client');
        }
        preset = value;
      },
    },
    flagOptions: {
      '--defer-pairing-commit': () => {
        if (deferPairingCommit) return error('Duplicate --defer-pairing-commit');
        deferPairingCommit = true;
      },
    },
  });
  if ('kind' in options) return options;
  if (!principalId || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(principalId)) {
    return error('runtime-host setup requires a valid --principal');
  }
  if (!preset) return error('runtime-host setup requires --preset');
  return {
    kind: 'runtime-host-setup',
    ...options,
    principalId,
    preset,
    deferPairingCommit,
  };
}

function parseServiceManagementCommand(argv: string[]): RuntimeHostCliCommand {
  const action = argv[0];
  if (
    action !== 'install' &&
    action !== 'status' &&
    action !== 'start' &&
    action !== 'stop' &&
    action !== 'restart' &&
    action !== 'logs' &&
    action !== 'uninstall'
  ) {
    return error(
      action
        ? `Unexpected runtime-host service command: ${action}`
        : 'runtime-host service requires install, status, start, stop, restart, logs, or uninstall',
    );
  }

  let retainManagedDeployment = false;
  let clientDataRoot: string | undefined;
  const options = parseManagedServiceOptions(argv.slice(1), {
    allowConfiguration: action === 'install',
    allowFramed: true,
    valueOptions: {
      '--client-data-root': (value) => {
        if (clientDataRoot !== undefined) return error('Duplicate --client-data-root');
        if (!isSafeAbsolutePath(value)) return error('--client-data-root must be an absolute path');
        clientDataRoot = value;
      },
    },
    ...(action === 'uninstall'
      ? {
          flagOptions: {
            '--retain-managed-deployment': () => {
              if (retainManagedDeployment) return error('Duplicate --retain-managed-deployment');
              retainManagedDeployment = true;
            },
          },
        }
      : {}),
  });
  if ('kind' in options) return options;
  return {
    kind: 'runtime-host-service-manage',
    action,
    ...options,
    ...(clientDataRoot ? { clientDataRoot } : {}),
    ...(retainManagedDeployment ? { retainManagedDeployment: true } : {}),
  };
}

interface ManagedServiceOptions {
  readonly json: boolean;
  readonly framed?: true;
  readonly rootPath?: string;
  readonly projectDirectoryRoots?: { readonly label: string; readonly path: string }[];
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
      else if (argument === '--project-root') {
        const root = parseProjectRoot(parsed);
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
    ...(projectDirectoryRoots.length > 0 ? { projectDirectoryRoots } : {}),
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
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      rootPath = parsed;
      index += 1;
      continue;
    }
    if (action === 'add' && path === undefined) {
      path = argument;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (action === 'list') {
    return { kind: 'runtime-host-project-list', ...(rootPath ? { rootPath } : {}) };
  }
  if (!path) return error('runtime-host project add requires a path');
  return { kind: 'runtime-host-project-add', path, ...(rootPath ? { rootPath } : {}) };
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
    if (argument === '--expected-root') expectedRootId = parsed;
    if (argument === '--credential-env') credentialEnv = parsed;
    index += 1;
  }
  if (!id) return error('--id is required');
  if (!name) return error('--name is required');
  if ((tlsUrl ? 1 : 0) + (plaintextUrl ? 1 : 0) + (sshDestination ? 1 : 0) !== 1) {
    return error('exactly one of --tls-url, --plaintext-url, or --ssh-destination is required');
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
        : {
            kind: 'ssh',
            destination: sshDestination!,
            ...(sshPort === undefined ? {} : { sshPort }),
            remotePort: sshRemotePort!,
            websocketPath: sshWebSocketPath,
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
  let json = false;
  let websocketHost = '127.0.0.1';
  let websocketConfigured = false;
  let websocketPort: number | undefined;
  let websocketPath: string | undefined;
  let tlsCertificatePath: string | undefined;
  let tlsPrivateKeyPath: string | undefined;
  let allowInsecureRemote = false;
  const allowedOrigins: string[] = [];
  const projectDirectoryRoots: { label: string; path: string }[] = [];
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
    if (argument === '--project-root') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      const root = parseProjectRoot(parsed);
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
  return {
    kind: 'runtime-host-serve',
    json,
    ...(rootPath ? { rootPath } : {}),
    ...(projectDirectoryRoots.length > 0 ? { projectDirectoryRoots } : {}),
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
  };
}

function parseProjectRoot(value: string): { label: string; path: string } | RuntimeHostCliError {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    return error('--project-root must use <label>=<absolute-path>');
  }
  const label = value.slice(0, separator).trim();
  const path = value.slice(separator + 1);
  if (
    label.length === 0 ||
    Buffer.byteLength(label, 'utf8') > PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    return error('--project-root label is invalid');
  }
  if (!isAbsolute(path)) return error('--project-root path must be absolute');
  return { label, path };
}

function parseAccessCommand(argv: string[]): RuntimeHostCliCommand {
  const action = argv[0];
  if (action !== 'issue' && action !== 'revoke') {
    return error(
      action
        ? `Unexpected runtime-host access command: ${action}`
        : 'runtime-host access requires the issue or revoke command',
    );
  }
  let rootPath: string | undefined;
  let principalId: string | undefined;
  let principalKind: 'remote_owner' | 'capability_provider' = 'remote_owner';
  let principalKindSpecified = false;
  let credentialId: string | undefined;
  const operationGrants: string[] = [];
  let canPublishClientCapabilities = false;
  let canUseHostPaths = false;
  let preset: 'desktop-client' | 'terminal-client' | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
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
      argument === '--kind' ||
      argument === '--preset' ||
      argument === '--principal' ||
      argument === '--grant' ||
      argument === '--credential'
    ) {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      if (argument === '--root') rootPath = parsed;
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
      index += 1;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (action === 'issue') {
    if (!principalId) return error('--principal is required');
    if (credentialId) return error('--credential is only valid for access revoke');
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
      principalKind,
      principalId,
      operationGrants,
      canPublishClientCapabilities,
      canUseHostPaths,
    };
  }
  if (!credentialId) return error('--credential is required');
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
    credentialId,
  };
}

function optionValue(argv: string[], index: number, option: string): string | RuntimeHostCliError {
  const value = argv[index + 1];
  return !value || value.startsWith('-') ? error(`${option} requires a value`) : value;
}

function error(message: string): RuntimeHostCliError {
  return { kind: 'error', message, exitCode: 2 };
}

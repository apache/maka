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

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { connectRemoteRuntimeHost } from '@maka/runtime-host/client';
import {
  encodeRuntimeHostSetupFrame,
  RUNTIME_HOST_SETUP_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SETUP_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostSetupFrame,
  type RuntimeHostSetupPhase,
} from '@maka/runtime-host/operator';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import { withFileUpdateLock } from '@maka/storage/file-update-lock';
import {
  prepareRuntimeHostAccessCredential,
  replaceRuntimeHostAccessCredential,
  revokeRuntimeHostAccessCredential,
  type RuntimeHostAccessPreset,
} from './runtime-host-access-command.js';
import {
  isRuntimeHostDevelopmentPackageVersion,
  prepareRuntimeHostManagedPackageDeployment,
  RuntimeHostManagedDeploymentError,
} from './runtime-host-managed-deployment.js';
import { createPlatformRuntimeHostServiceBackend } from './runtime-host-service-management-command.js';
import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostManagedServiceTarget,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';

const SETUP_LOCK_TIMEOUT_MS = 5 * 60_000;

export interface RuntimeHostSetupCliOptions {
  readonly json: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly sourcePackageRoot: string;
  readonly version: string;
  readonly principalId: string;
  readonly preset: RuntimeHostAccessPreset;
  readonly deferPairingCommit?: boolean;
  readonly rootPath?: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly websocketPort?: number;
  readonly websocketPath?: string;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
}

interface RuntimeHostSetupDeps {
  readonly manageService: typeof manageRuntimeHostService;
  readonly createBackend: (serviceId: string) => RuntimeHostServiceBackend;
  readonly prepareDeployment: typeof prepareRuntimeHostManagedPackageDeployment;
  readonly prepareCredential: typeof prepareRuntimeHostAccessCredential;
  readonly replaceCredential: typeof replaceRuntimeHostAccessCredential;
  readonly revokeCredential: typeof revokeRuntimeHostAccessCredential;
  readonly verifyCredential: typeof verifyRuntimeHostSetupCredential;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

class RuntimeHostSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostSetupError';
  }
}

export async function runRuntimeHostSetupCli(
  options: RuntimeHostSetupCliOptions,
  overrides: Partial<RuntimeHostSetupDeps> = {},
): Promise<number> {
  const deps: RuntimeHostSetupDeps = {
    manageService: manageRuntimeHostService,
    createBackend: createPlatformRuntimeHostServiceBackend,
    prepareDeployment: prepareRuntimeHostManagedPackageDeployment,
    prepareCredential: prepareRuntimeHostAccessCredential,
    replaceCredential: replaceRuntimeHostAccessCredential,
    revokeCredential: revokeRuntimeHostAccessCredential,
    verifyCredential: verifyRuntimeHostSetupCredential,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  const emit = createEmitter(options.json, deps);
  try {
    await mkdir(options.clientDataRoot, { recursive: true, mode: 0o700 });
    await withFileUpdateLock(
      join(options.clientDataRoot, 'runtime-host-setup'),
      () => runRuntimeHostSetupLocked(options, deps, emit),
      SETUP_LOCK_TIMEOUT_MS,
    );
    return 0;
  } catch (error) {
    const failure = setupFailure(error);
    emit({ kind: 'error', error: failure });
    return 1;
  }
}

async function runRuntimeHostSetupLocked(
  options: RuntimeHostSetupCliOptions,
  deps: RuntimeHostSetupDeps,
  emit: SetupEmitter,
): Promise<void> {
  emit({ kind: 'progress', phase: 'checking_environment' });
  const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
  const backend = deps.createBackend(serviceId);
  const common = {
    clientDataRoot: options.clientDataRoot,
    defaultRootPath: options.defaultRootPath,
    nodePath: process.execPath,
    cliPath: join(options.sourcePackageRoot, 'dist', 'cli.js'),
    ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
  } as const;
  const status = await deps.manageService({ ...common, action: 'status' }, backend);
  await assertCompatibleExistingVersion(status, options.version);

  emit({ kind: 'progress', phase: 'installing_package' });
  const deployment = await deps.prepareDeployment({
    serviceId,
    clientDataRoot: options.clientDataRoot,
    sourcePackageRoot: options.sourcePackageRoot,
    version: options.version,
  });

  emit({ kind: 'progress', phase: 'installing_service' });
  let installed: RuntimeHostManagedServiceResult;
  try {
    installed = await deps.manageService(
      {
        ...common,
        action: 'install',
        cliPath: deployment.cliPath,
        ...(options.rootPath ? { rootPath: options.rootPath } : {}),
        ...(options.projectDirectoryRoots
          ? { projectDirectoryRoots: options.projectDirectoryRoots }
          : {}),
        ...(options.websocketPort === undefined ? {} : { websocketPort: options.websocketPort }),
        ...(options.websocketPath ? { websocketPath: options.websocketPath } : {}),
      },
      backend,
    );
  } catch (error) {
    await deployment.rollback().catch(() => undefined);
    throw error;
  }
  const config = installed.service.config;
  if (!config || !installed.service.active) {
    throw new RuntimeHostSetupError(
      'service_not_ready',
      'Managed Runtime Host service did not become ready',
    );
  }
  await deployment.commit();

  emit({ kind: 'progress', phase: 'pairing_client' });
  let paired: Awaited<ReturnType<typeof prepareRuntimeHostAccessCredential>>;
  try {
    const pairCredential = options.deferPairingCommit
      ? deps.prepareCredential
      : deps.replaceCredential;
    paired = await pairCredential({
      rootPath: config.rootPath,
      principalKind: 'remote_owner',
      principalId: options.principalId,
      operationGrants: [],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
      preset: options.preset,
    });
  } catch (error) {
    throw new RuntimeHostSetupError(
      'pairing_failed',
      'Runtime Host could not pair the requested Client identity',
      { cause: error },
    );
  }

  const endpoint = websocketUrl(config.websocket);
  emit({ kind: 'progress', phase: 'verifying_connection' });
  try {
    await deps.verifyCredential({
      endpoint,
      rootId: paired.rootId,
      credential: paired.credential,
    });
    emit({
      kind: 'complete',
      version: deployment.version,
      serviceId,
      operatorPath: deployment.operatorPath,
      rootPath: config.rootPath,
      rootId: paired.rootId,
      endpoint,
      credentialId: paired.credentialId,
      credential: paired.credential,
    });
  } catch (error) {
    if (options.deferPairingCommit) {
      try {
        await deps.revokeCredential({
          rootPath: config.rootPath,
          credentialId: paired.credentialId,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Runtime Host pairing failed and its candidate credential could not be revoked',
        );
      }
    }
    throw error;
  }
}

async function assertCompatibleExistingVersion(
  status: RuntimeHostManagedServiceResult,
  version: string,
): Promise<void> {
  if (!status.service.config) {
    if (!status.service.installed) return;
    throw new RuntimeHostSetupError(
      'existing_installation_unknown',
      'The installed Runtime Host configuration is unavailable; repair it before setup',
    );
  }
  const existingVersion = status.service.installedVersion;
  if (!existingVersion) {
    throw new RuntimeHostSetupError(
      'existing_installation_unknown',
      'The installed Runtime Host version could not be identified; repair it before setup',
    );
  }
  if (
    existingVersion !== version &&
    !(
      isRuntimeHostDevelopmentPackageVersion(existingVersion) &&
      isRuntimeHostDevelopmentPackageVersion(version)
    )
  ) {
    throw new RuntimeHostSetupError(
      'version_change_requires_update',
      `Runtime Host ${String(existingVersion)} is already installed; changing to ${version} requires the update workflow`,
    );
  }
}

async function verifyRuntimeHostSetupCredential(input: {
  readonly endpoint: string;
  readonly rootId: string;
  readonly credential: string;
}): Promise<void> {
  const result = await connectRemoteRuntimeHost({
    url: input.endpoint,
    credential: input.credential,
    expectedRootId: input.rootId,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  });
  if (result.kind !== 'connected') {
    throw new RuntimeHostSetupError(
      'verification_failed',
      `The paired Runtime Host connection could not be verified (${result.kind})`,
    );
  }
  try {
    const status = await result.connection.status();
    if (status.state !== 'ready') {
      throw new RuntimeHostSetupError(
        'verification_failed',
        `The paired Runtime Host is ${status.state}`,
      );
    }
  } finally {
    await result.connection.close();
  }
}

type SetupEmitter = (
  frame:
    | Omit<Extract<RuntimeHostSetupFrame, { kind: 'progress' }>, 'schemaVersion' | 'sequence'>
    | Omit<Extract<RuntimeHostSetupFrame, { kind: 'complete' }>, 'schemaVersion' | 'sequence'>
    | Omit<Extract<RuntimeHostSetupFrame, { kind: 'error' }>, 'schemaVersion' | 'sequence'>,
) => void;

function createEmitter(json: boolean, deps: RuntimeHostSetupDeps): SetupEmitter {
  let sequence = 0;
  return (input) => {
    const frame = { schemaVersion: 1, sequence: sequence++, ...input } as RuntimeHostSetupFrame;
    if (json) {
      deps.writeOutput(encodeRuntimeHostSetupFrame(frame));
      return;
    }
    if (frame.kind === 'progress') {
      deps.writeOutput(`${humanPhase(frame.phase)}\n`);
    } else if (frame.kind === 'complete') {
      deps.writeOutput(`${JSON.stringify(frame, null, 2)}\n`);
    } else {
      deps.writeError(`${frame.error.message}\n`);
    }
  };
}

function setupFailure(error: unknown): { code: string; message: string } {
  let code = 'internal_setup_failure';
  let message = 'Runtime Host setup failed';
  if (
    error instanceof RuntimeHostSetupError ||
    error instanceof RuntimeHostServiceManagerError ||
    error instanceof RuntimeHostManagedDeploymentError
  ) {
    code = error.code;
    message = error.message;
  }
  return {
    code: truncateUtf8(code, RUNTIME_HOST_SETUP_ERROR_CODE_MAX_BYTES) || 'internal_setup_failure',
    message:
      truncateUtf8(message, RUNTIME_HOST_SETUP_ERROR_MESSAGE_MAX_BYTES) ||
      'Runtime Host setup failed',
  };
}

function websocketUrl(input: {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}) {
  return `ws://${input.host}:${input.port}${input.path}`;
}

function humanPhase(phase: RuntimeHostSetupPhase): string {
  switch (phase) {
    case 'checking_environment':
      return 'Checking the remote environment...';
    case 'installing_package':
      return 'Installing the managed Maka package...';
    case 'installing_service':
      return 'Installing the Runtime Host service...';
    case 'pairing_client':
      return 'Pairing the Client...';
    case 'verifying_connection':
      return 'Verifying the Runtime Host connection...';
  }
}

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

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  compareProductReleaseVersions,
  encodeRuntimeHostServiceManagementFrame,
  isProductReleaseVersion,
  isSha512PackageIntegrity,
  RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostNpmDeploymentIdentity,
} from '@maka/runtime-host/operator';
import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceTarget,
} from './runtime-host-service-manager.js';
import {
  createPlatformRuntimeHostServiceBackend,
  runtimeHostServiceSummary,
} from './runtime-host-service-management-command.js';
import { resolveRuntimeHostManagedPackageCliPath } from './runtime-host-managed-deployment.js';
import type { RuntimeHostUpdateSelector } from './runtime-host-cli.js';

const PACKAGE_NAME = 'maka-agent';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const COMPATIBILITY_FIELD = 'maka.managedRuntimeHostUpdateCompatibility';
const REGISTRY_TIMEOUT_MS = 30_000;
const REGISTRY_OUTPUT_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;

export interface RuntimeHostUpdateCandidate extends RuntimeHostNpmDeploymentIdentity {
  readonly compatibility?: number;
}

export type RuntimeHostUpdateCheckFrame = Extract<
  RuntimeHostServiceManagementFrame,
  { kind: 'result'; action: 'check_update' }
>;
type RuntimeHostUpdateCheck = RuntimeHostUpdateCheckFrame['updateCheck'];

export interface RuntimeHostUpdateCheckOptions {
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly selector: RuntimeHostUpdateSelector;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
}

export interface RuntimeHostUpdateCheckCliOptions extends RuntimeHostUpdateCheckOptions {
  readonly json: boolean;
  readonly framed: boolean;
}

export class RuntimeHostUpdateDiscoveryError extends Error {
  constructor(
    readonly code: 'target_unavailable' | 'registry_unavailable' | 'invalid_registry_metadata',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostUpdateDiscoveryError';
  }
}

export async function runManagedRuntimeHostUpdateCheckCli(
  options: RuntimeHostUpdateCheckCliOptions,
): Promise<number> {
  try {
    const frame = await resolveManagedRuntimeHostUpdateCheck(options);
    writeSuccess(frame, options);
    return 0;
  } catch (error) {
    const code =
      error instanceof RuntimeHostUpdateDiscoveryError ||
      error instanceof RuntimeHostServiceManagerError
        ? error.code
        : 'update_check_failed';
    const message = error instanceof Error ? error.message : String(error);
    writeFailure(code, message, options);
    return 1;
  }
}

export interface RuntimeHostUpdateSelection {
  readonly service: RuntimeHostUpdateCheckFrame['service'];
  readonly currentCliPath: string;
  readonly selector: RuntimeHostUpdateSelector;
  readonly candidate: RuntimeHostUpdateCandidate;
  readonly outcome: RuntimeHostUpdateCheck['outcome'];
}

export function resolveManagedRuntimeHostUpdateSelection(
  options: RuntimeHostUpdateCheckOptions,
): Promise<RuntimeHostUpdateSelection> {
  return resolveManagedRuntimeHostUpdate(options, false);
}

async function resolveManagedRuntimeHostUpdateCheck(
  options: RuntimeHostUpdateCheckOptions,
): Promise<RuntimeHostUpdateCheckFrame> {
  return updateCheckFrame(await resolveManagedRuntimeHostUpdate(options, true));
}

async function resolveManagedRuntimeHostUpdate(
  options: RuntimeHostUpdateCheckOptions,
  verifyDeployment: boolean,
): Promise<RuntimeHostUpdateSelection> {
  const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
  const backend = createPlatformRuntimeHostServiceBackend(serviceId);
  const status = await manageRuntimeHostService(
    {
      action: 'status',
      clientDataRoot: options.clientDataRoot,
      defaultRootPath: options.defaultRootPath,
      nodePath: process.execPath,
      cliPath: process.argv[1] ?? '',
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
    },
    backend,
  );
  const currentVersion = status.service.installedVersion;
  const config = status.service.config;
  const service = runtimeHostServiceSummary(status);
  const serviceState = service.state;
  if (
    !status.service.installed ||
    serviceState === 'not_installed' ||
    !currentVersion ||
    !config?.managedDeploymentRoot
  ) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'A Maka-managed Runtime Host service is required to check for updates',
    );
  }
  if (verifyDeployment) await backend.verifyDeployment(config);
  const [candidate, currentCompatibility] = await Promise.all([
    resolveRuntimeHostRegistryUpdateCandidate(options.selector),
    readPackageCompatibility(config.launch.cliPath, currentVersion),
  ]);
  const currentCliPath = resolve(config.launch.cliPath);
  const targetCliPath = resolveRuntimeHostManagedPackageCliPath(
    config.managedDeploymentRoot,
    candidate.version,
    candidate.integrity,
  );
  const assessment = assessRuntimeHostUpdate(
    currentVersion,
    currentCompatibility,
    candidate,
    currentCliPath === targetCliPath,
  );
  return {
    service: {
      ...service,
      state: serviceState,
      installedVersion: currentVersion,
    },
    currentCliPath,
    selector: options.selector,
    candidate,
    outcome: assessment,
  };
}

function updateCheckFrame(selection: RuntimeHostUpdateSelection): RuntimeHostUpdateCheckFrame {
  return {
    schemaVersion: 1,
    kind: 'result',
    action: 'check_update',
    service: selection.service,
    updateCheck: {
      selector: selection.selector,
      candidate: {
        version: selection.candidate.version,
        integrity: selection.candidate.integrity,
      },
      outcome: selection.outcome,
    },
  };
}

export function assessRuntimeHostUpdate(
  currentVersion: string,
  currentCompatibility: number | undefined,
  candidate: RuntimeHostUpdateCandidate,
  currentDeploymentMatchesCandidate: boolean,
): RuntimeHostUpdateCheck['outcome'] {
  const relation = compareProductReleaseVersions(candidate.version, currentVersion);
  if (relation === 0 && currentDeploymentMatchesCandidate) return { kind: 'current' };
  if (relation < 0) {
    return { kind: 'manual_action', reason: 'target_not_newer' };
  }
  if (currentCompatibility === undefined) {
    return { kind: 'manual_action', reason: 'current_compatibility_unknown' };
  }
  if (candidate.compatibility === undefined) {
    return { kind: 'manual_action', reason: 'target_compatibility_unknown' };
  }
  return candidate.compatibility === currentCompatibility
    ? { kind: 'unattended_update', compatibility: currentCompatibility }
    : { kind: 'manual_action', reason: 'compatibility_mismatch' };
}

export async function resolveRuntimeHostRegistryUpdateCandidate(
  selector: RuntimeHostUpdateSelector,
  run: (args: readonly string[]) => Promise<NpmViewResult> = runNpmView,
): Promise<RuntimeHostUpdateCandidate> {
  const target = selector.kind === 'channel' ? selector.channel : selector.version;
  const result = await run([
    'view',
    `${PACKAGE_NAME}@${target}`,
    'version',
    'dist.integrity',
    COMPATIBILITY_FIELD,
    '--json',
    '--registry',
    NPM_REGISTRY,
  ]);
  if (result.exitCode !== 0) {
    const failure = parseJson(result.stdout);
    const code = isRecord(failure) && isRecord(failure.error) ? failure.error.code : undefined;
    throw new RuntimeHostUpdateDiscoveryError(
      code === 'E404' ? 'target_unavailable' : 'registry_unavailable',
      code === 'E404'
        ? `No Maka package is published for ${target}`
        : 'The Maka package registry is unavailable',
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(result.stdout);
  } catch (error) {
    throw new RuntimeHostUpdateDiscoveryError(
      'invalid_registry_metadata',
      'The npm registry returned invalid Maka package metadata',
      { cause: error },
    );
  }
  if (!isRecord(metadata)) return invalidMetadata();
  const version = metadata.version;
  const integrity = metadata['dist.integrity'];
  if (
    typeof version !== 'string' ||
    !isProductReleaseVersion(version) ||
    (selector.kind === 'exact' && version !== selector.version) ||
    typeof integrity !== 'string' ||
    !isSha512PackageIntegrity(integrity)
  ) {
    return invalidMetadata();
  }
  const compatibility = positiveInteger(metadata[COMPATIBILITY_FIELD]);
  return {
    kind: 'npm_registry',
    version,
    integrity,
    ...(compatibility === undefined ? {} : { compatibility }),
  };
}

async function readPackageCompatibility(
  cliPath: string,
  expectedVersion: string,
): Promise<number | undefined> {
  try {
    const raw = await readFile(join(dirname(dirname(cliPath)), 'package.json'), 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MANIFEST_MAX_BYTES) return undefined;
    const manifest: unknown = JSON.parse(raw);
    if (
      !isRecord(manifest) ||
      manifest.name !== PACKAGE_NAME ||
      manifest.version !== expectedVersion
    ) {
      return undefined;
    }
    return isRecord(manifest.maka)
      ? positiveInteger(manifest.maka.managedRuntimeHostUpdateCompatibility)
      : undefined;
  } catch {
    return undefined;
  }
}

interface NpmViewResult {
  readonly exitCode: number;
  readonly stdout: string;
}

function runNpmView(args: readonly string[]): Promise<NpmViewResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: REGISTRY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let bytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > REGISTRY_OUTPUT_MAX_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (bytes > REGISTRY_OUTPUT_MAX_BYTES) {
        reject(
          new RuntimeHostUpdateDiscoveryError(
            'invalid_registry_metadata',
            'The npm registry returned oversized Maka package metadata',
          ),
        );
        return;
      }
      resolve({ exitCode: exitCode ?? 1, stdout });
    });
  });
}

function writeSuccess(
  frame: RuntimeHostUpdateCheckFrame,
  options: RuntimeHostUpdateCheckCliOptions,
): void {
  if (options.framed) process.stdout.write(encodeRuntimeHostServiceManagementFrame(frame));
  else if (options.json) process.stdout.write(`${JSON.stringify({ ...frame, ok: true })}\n`);
  else process.stdout.write(`${formatRuntimeHostUpdateCheck(frame)}\n`);
}

export function formatRuntimeHostUpdateCheck(frame: RuntimeHostUpdateCheckFrame): string {
  const check = frame.updateCheck;
  if (check.outcome.kind === 'current') {
    return `Runtime Host ${frame.service.installedVersion} already matches the selected target.`;
  }
  if (check.outcome.kind === 'unattended_update') {
    return `Runtime Host ${check.candidate.version} is available for unattended update.`;
  }
  switch (check.outcome.reason) {
    case 'target_not_newer':
      return `Selected Runtime Host ${check.candidate.version} is older than installed ${frame.service.installedVersion}; manual selection is required.`;
    case 'current_compatibility_unknown':
      return `Runtime Host ${check.candidate.version} requires a manual update because the installed package has no unattended-update compatibility evidence.`;
    case 'target_compatibility_unknown':
      return `Runtime Host ${check.candidate.version} requires a manual update because the target package has no unattended-update compatibility evidence.`;
    case 'compatibility_mismatch':
      return `Runtime Host ${check.candidate.version} requires a manual update because it crosses the declared compatibility boundary.`;
  }
}

function writeFailure(
  code: string,
  message: string,
  options: RuntimeHostUpdateCheckCliOptions,
): void {
  const error = {
    code: truncateUtf8(code, RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES) || 'update_check_failed',
    message:
      truncateUtf8(message, RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES) ||
      'Runtime Host update check failed',
  };
  if (options.framed) {
    process.stdout.write(
      encodeRuntimeHostServiceManagementFrame({
        schemaVersion: 1,
        kind: 'error',
        action: 'check_update',
        error,
      }),
    );
  } else if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ok: false, action: 'check_update', error })}\n`,
    );
  } else process.stderr.write(`${error.message}\n`);
}

function invalidMetadata(): never {
  throw new RuntimeHostUpdateDiscoveryError(
    'invalid_registry_metadata',
    'The npm registry returned incomplete Maka package metadata',
  );
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

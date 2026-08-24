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
import { dirname, join } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  encodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceTarget,
} from './runtime-host-service-manager.js';
import {
  compareProductReleaseVersions,
  isProductReleaseVersion,
} from './product-release-version.js';
import {
  createPlatformRuntimeHostServiceBackend,
  runtimeHostServiceSummary,
} from './runtime-host-service-management-command.js';
import type { RuntimeHostUpdateSelector } from './runtime-host-cli.js';

const PACKAGE_NAME = 'maka-agent';
const COMPATIBILITY_FIELD = 'maka.managedRuntimeHostUpdateCompatibility';
const REGISTRY_TIMEOUT_MS = 30_000;
const REGISTRY_OUTPUT_MAX_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;

export interface RuntimeHostUpdateCandidate {
  readonly version: string;
  readonly integrity: string;
  readonly compatibility?: number;
}

type RuntimeHostUpdateCheck = Extract<
  RuntimeHostServiceManagementFrame,
  { kind: 'result'; action: 'check_update' }
>['updateCheck'];

export interface RuntimeHostUpdateCheckCliOptions {
  readonly json: boolean;
  readonly framed: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly selector: RuntimeHostUpdateSelector;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
}

class RuntimeHostUpdateDiscoveryError extends Error {
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
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    const status = await manageRuntimeHostService(
      {
        action: 'status',
        clientDataRoot: options.clientDataRoot,
        defaultRootPath: options.defaultRootPath,
        nodePath: process.execPath,
        cliPath: process.argv[1] ?? '',
        ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
      },
      createPlatformRuntimeHostServiceBackend(serviceId),
    );
    const currentVersion = status.service.installedVersion;
    const config = status.service.config;
    if (!status.service.installed || !currentVersion || !config?.managedDeploymentRoot) {
      throw new RuntimeHostServiceManagerError(
        'not_installed',
        'A Maka-managed Runtime Host service is required to check for updates',
      );
    }
    const [candidate, currentCompatibility] = await Promise.all([
      resolveRuntimeHostRegistryUpdateCandidate(options.selector),
      readPackageCompatibility(config.launch.cliPath, currentVersion),
    ]);
    const assessment = assessRuntimeHostUpdate(currentVersion, currentCompatibility, candidate);
    const frame: RuntimeHostServiceManagementFrame = {
      schemaVersion: 1,
      kind: 'result',
      action: 'check_update',
      service: runtimeHostServiceSummary(status),
      updateCheck: {
        selector: options.selector,
        currentVersion,
        candidate: { version: candidate.version, integrity: candidate.integrity },
        ...assessment,
      },
    };
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

export function assessRuntimeHostUpdate(
  currentVersion: string,
  currentCompatibility: number | undefined,
  candidate: RuntimeHostUpdateCandidate,
): Pick<RuntimeHostUpdateCheck, 'status' | 'unattended'> {
  const relation = compareProductReleaseVersions(candidate.version, currentVersion);
  if (relation === 0) return { status: 'current', unattended: { kind: 'not_needed' } };
  if (relation < 0) {
    return {
      status: 'older',
      unattended: { kind: 'manual_only', reason: 'target_not_newer' },
    };
  }
  const status = 'newer' as const;
  if (currentCompatibility === undefined) {
    return {
      status,
      unattended: { kind: 'manual_only', reason: 'current_compatibility_unknown' },
    };
  }
  if (candidate.compatibility === undefined) {
    return {
      status,
      unattended: { kind: 'manual_only', reason: 'target_compatibility_unknown' },
    };
  }
  return {
    status,
    unattended:
      candidate.compatibility === currentCompatibility
        ? { kind: 'allowed', compatibility: currentCompatibility }
        : { kind: 'manual_only', reason: 'compatibility_mismatch' },
  };
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
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity) ||
    Buffer.byteLength(integrity, 'utf8') > 512
  ) {
    return invalidMetadata();
  }
  const compatibility = positiveInteger(metadata[COMPATIBILITY_FIELD]);
  return { version, integrity, ...(compatibility === undefined ? {} : { compatibility }) };
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
    // Windows requires its command shell to resolve npm.cmd. The only dynamic
    // argument has already passed the strict release-version/channel parser.
    const child = spawn('npm', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: process.platform === 'win32',
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
  frame: Extract<RuntimeHostServiceManagementFrame, { kind: 'result'; action: 'check_update' }>,
  options: RuntimeHostUpdateCheckCliOptions,
): void {
  if (options.framed) process.stdout.write(encodeRuntimeHostServiceManagementFrame(frame));
  else if (options.json) process.stdout.write(`${JSON.stringify({ ...frame, ok: true })}\n`);
  else {
    const check = frame.updateCheck;
    if (check.status === 'current') {
      process.stdout.write(
        `Runtime Host ${check.currentVersion} already matches the selected target.\n`,
      );
    } else if (check.unattended.kind === 'allowed') {
      process.stdout.write(
        `Runtime Host ${check.candidate.version} is available for unattended update.\n`,
      );
    } else if (check.status === 'older') {
      process.stdout.write(
        `Selected Runtime Host ${check.candidate.version} is older than installed ${check.currentVersion}; manual selection is required.\n`,
      );
    } else {
      process.stdout.write(
        `Runtime Host ${check.candidate.version} is available for manual update.\n`,
      );
    }
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

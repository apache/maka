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

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isCanonicalWindowsPath } from '@maka/core/windows-path';

import type { SandboxBackend, SandboxTransformRequest, SandboxTransformResult } from './types.js';
import { compileWindowsSandboxPolicy } from './windows-profile.js';

/**
 * Default broker-side child deadline. The runtime's own worker timeout
 * (FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS, 120s) always fires first so error
 * classification stays `timeout`; the broker deadline is the backstop that
 * guarantees Job teardown if the runtime process dies mid-request.
 */
export const DEFAULT_WINDOWS_BROKER_TIMEOUT_MS = 130_000;
const MIN_WINDOWS_BROKER_TIMEOUT_MS = 1_000;
const MAX_WINDOWS_BROKER_TIMEOUT_MS = 600_000;
const MAX_WINDOWS_BROKER_REQUEST_ID_LENGTH = 128 - '-launch'.length;

export interface WindowsBrokerManifest {
  readonly version: 1;
  readonly requestId: string;
  readonly clientPid: 0;
  readonly clientNonce: string;
  readonly profileDigest: string;
  readonly launch: {
    readonly version: 1;
    readonly requestId: string;
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly readRoots: readonly string[];
    readonly writeRoots: readonly string[];
    readonly exactReadRoots: readonly string[];
    readonly exactWriteRoots: readonly string[];
    readonly network: 'restricted' | 'enabled';
    readonly environment: Readonly<Record<string, string>>;
    /** Serialized last so manifests without it keep their historical digest. */
    readonly timeoutMs: number;
  };
}

export interface WindowsSandboxBackendOptions {
  readonly clientPath: string;
  readonly writeManifest: (manifest: WindowsBrokerManifest) => string;
  readonly nonce?: () => string;
  readonly requestId?: () => string;
  readonly isAvailable?: () => boolean;
  /** Broker child deadline in ms; defaults to DEFAULT_WINDOWS_BROKER_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

export function createWindowsBrokerManifestWriter(
  temporaryRoot: string = tmpdir(),
): (manifest: WindowsBrokerManifest) => string {
  const directory = mkdtempSync(join(temporaryRoot, 'maka-windows-sandbox-'));
  return (manifest) => {
    // Windows cleanup tools may remove idle temp directories between turns.
    // Recreate it before each one-shot broker request.
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${manifest.requestId}-${randomBytes(8).toString('hex')}.json`);
    const descriptor = openSync(path, 'wx', 0o600);
    try {
      try {
        writeFileSync(descriptor, JSON.stringify(manifest), 'utf8');
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    return path;
  };
}

export class WindowsBrokerSandboxBackend implements SandboxBackend {
  readonly type = 'windows' as const;

  constructor(private readonly options: WindowsSandboxBackendOptions) {}

  isAvailable(platform: string = process.platform): boolean {
    return platform === 'win32' && (this.options.isAvailable?.() ?? true);
  }

  canEnforceProfile(profile: SandboxTransformRequest['command']['profile']): boolean {
    return (
      profile.type === 'managed' &&
      profile.fileSystem.kind === 'restricted' &&
      profile.network.kind === 'restricted'
    );
  }

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    const preference = request.preference ?? 'auto';
    const platform = request.platform ?? process.platform;
    if (platform !== 'win32') {
      return failure(
        'unsupported_platform',
        'Windows broker backend requires win32.',
        platform,
        preference,
      );
    }
    if (!this.isAvailable(platform)) {
      return failure(
        'backend_not_available',
        'Windows sandbox broker client is not available.',
        platform,
        preference,
      );
    }
    const configurationError = validateConfiguration(this.options);
    if (configurationError) {
      return failure('invalid_request', configurationError, platform, preference);
    }

    let policy;
    try {
      policy = compileWindowsSandboxPolicy(request.command);
    } catch (error) {
      return failure(
        'invalid_request',
        error instanceof Error ? error.message : String(error),
        platform,
        preference,
      );
    }

    const requestId = this.options.requestId?.() ?? randomBytes(16).toString('hex');
    const clientNonce = this.options.nonce?.() ?? randomBytes(16).toString('hex');
    // The request id is embedded in the manifest filename; NTFS treats ':'
    // as an alternate-data-stream separator, so only Windows-filename-safe
    // characters are accepted.
    if (
      requestId.length === 0 ||
      requestId.length > MAX_WINDOWS_BROKER_REQUEST_ID_LENGTH ||
      !/^[A-Za-z0-9._-]+$/u.test(requestId)
    ) {
      return failure('invalid_request', 'Invalid Windows broker request id.', platform, preference);
    }
    if (!/^[a-f0-9]{32}$/iu.test(clientNonce)) {
      return failure(
        'invalid_request',
        'Invalid Windows broker client nonce.',
        platform,
        preference,
      );
    }
    let manifestPath: string;
    try {
      const launch: WindowsBrokerManifest['launch'] = {
        version: 1,
        requestId: `${requestId}-launch`,
        executable: request.command.program,
        arguments: request.command.args,
        cwd: request.command.cwd,
        readRoots: policy.readRoots,
        writeRoots: policy.writeRoots,
        exactReadRoots: policy.exactReadRoots,
        exactWriteRoots: policy.exactWriteRoots,
        network: policy.network,
        // The marker tells the worker it runs inside the AppContainer, where
        // spawning ripgrep is impossible and Grep must fail closed instead of
        // approximating its contract. Only the broker path sets it, so an
        // unsandboxed worker keeps the full ripgrep behavior.
        environment: sortEnvironment({ ...policy.environment, MAKA_WINDOWS_SANDBOX: '1' }),
        timeoutMs: this.options.timeoutMs ?? DEFAULT_WINDOWS_BROKER_TIMEOUT_MS,
      };
      manifestPath = this.options.writeManifest({
        version: 1,
        requestId,
        clientPid: 0,
        clientNonce,
        profileDigest: digestLaunch(launch),
        launch,
      });
      if (!isCanonicalWindowsPath(manifestPath)) {
        throw new Error('manifest path must be canonical and absolute');
      }
    } catch (error) {
      return failure(
        'backend_not_available',
        `Unable to materialize Windows broker request: ${error instanceof Error ? error.message : String(error)}`,
        platform,
        preference,
      );
    }

    return {
      ok: true,
      exec: {
        argv: [this.options.clientPath, '--broker-local', manifestPath],
        cwd: request.command.cwd,
        env: request.command.env,
        sandboxType: 'windows',
        effectiveProfile: request.command.profile,
      },
      sandboxType: 'windows',
      requiresSandbox: true,
      preference,
    };
  }
}

function validateConfiguration(options: WindowsSandboxBackendOptions): string | undefined {
  if (!isCanonicalWindowsPath(options.clientPath)) {
    return 'Windows broker client path must be canonical and absolute.';
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < MIN_WINDOWS_BROKER_TIMEOUT_MS ||
      options.timeoutMs > MAX_WINDOWS_BROKER_TIMEOUT_MS)
  ) {
    return `Windows broker timeout must be an integer between ${MIN_WINDOWS_BROKER_TIMEOUT_MS} and ${MAX_WINDOWS_BROKER_TIMEOUT_MS} ms.`;
  }
  return undefined;
}

function digestLaunch(launch: WindowsBrokerManifest['launch']): string {
  return createHash('sha256').update(JSON.stringify(launch), 'utf8').digest('hex');
}

function sortEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
    ),
  );
}

function failure(
  reason: 'unsupported_platform' | 'backend_not_available' | 'invalid_request',
  message: string,
  platform: string,
  preference: 'auto' | 'require' | 'forbid',
): SandboxTransformResult {
  return {
    ok: false,
    reason,
    sandboxType: 'windows',
    requiresSandbox: true,
    platform,
    preference,
    message,
  };
}

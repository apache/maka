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
import { homedir } from 'node:os';
import {
  isProductReleaseVersion,
  isSha512PackageIntegrity,
  type RuntimeHostNpmDeploymentIdentity,
} from '@maka/runtime-host/operator/update-package-evidence';
import type { RuntimeHostUpdateSelector } from './runtime-host-cli.js';

const PACKAGE_NAME = 'maka-agent';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const COMPATIBILITY_FIELD = 'maka.managedRuntimeHostUpdateCompatibility';
const REGISTRY_TIMEOUT_MS = 30_000;
const REGISTRY_OUTPUT_MAX_BYTES = 64 * 1024;

export interface RuntimeHostUpdateCandidate extends RuntimeHostNpmDeploymentIdentity {
  readonly compatibility?: number;
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

interface NpmViewResult {
  readonly exitCode: number;
  readonly stdout: string;
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
      if (bytes > REGISTRY_OUTPUT_MAX_BYTES) child.kill('SIGKILL');
      else stdout += chunk;
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

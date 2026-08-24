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
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  isProductReleaseVersion,
  type RuntimeHostManagedUpdatePolicy,
} from '@maka/runtime-host/operator';
import type { RuntimeHostManagedServiceTarget } from './runtime-host-service-manager.js';

const UPDATE_POLICY_FILE = 'runtime-host-update-policy.json';
const UPDATE_POLICY_MAX_BYTES = 16 * 1024;

type AutomaticUpdatePolicy = Exclude<RuntimeHostManagedUpdatePolicy, { kind: 'manual' }>;

export interface RuntimeHostManagedUpdatePolicyRecord {
  readonly schemaVersion: 1;
  readonly policy: AutomaticUpdatePolicy;
  readonly target: RuntimeHostManagedServiceTarget;
}

export class RuntimeHostUpdatePolicyError extends Error {
  constructor(
    readonly code: 'invalid_update_policy' | 'update_policy_write_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostUpdatePolicyError';
  }
}

export function resolveRuntimeHostManagedUpdatePolicyPath(clientDataRoot: string): string {
  return join(clientDataRoot, UPDATE_POLICY_FILE);
}

export async function readRuntimeHostManagedUpdatePolicy(
  clientDataRoot: string,
): Promise<RuntimeHostManagedUpdatePolicyRecord | null> {
  const path = resolveRuntimeHostManagedUpdatePolicyPath(clientDataRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw new RuntimeHostUpdatePolicyError(
      'invalid_update_policy',
      `Unable to read the managed Runtime Host update policy at ${path}`,
      { cause: error },
    );
  }
  try {
    if (Buffer.byteLength(raw, 'utf8') > UPDATE_POLICY_MAX_BYTES) {
      throw new TypeError('Update policy exceeds its size limit');
    }
    const parsed: unknown = JSON.parse(raw);
    assertUpdatePolicyRecord(parsed);
    return parsed;
  } catch (error) {
    throw new RuntimeHostUpdatePolicyError(
      'invalid_update_policy',
      `Invalid managed Runtime Host update policy at ${path}`,
      { cause: error },
    );
  }
}

export async function writeRuntimeHostManagedUpdatePolicy(
  clientDataRoot: string,
  record: RuntimeHostManagedUpdatePolicyRecord | null,
): Promise<void> {
  const path = resolveRuntimeHostManagedUpdatePolicyPath(clientDataRoot);
  if (record === null) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      throw new RuntimeHostUpdatePolicyError(
        'update_policy_write_failed',
        `Unable to remove the managed Runtime Host update policy at ${path}`,
        { cause: error },
      );
    }
  }
  assertUpdatePolicyRecord(record);
  const directory = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    throw new RuntimeHostUpdatePolicyError(
      'update_policy_write_failed',
      `Unable to persist the managed Runtime Host update policy at ${path}`,
      { cause: error },
    );
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function assertUpdatePolicyRecord(
  value: unknown,
): asserts value is RuntimeHostManagedUpdatePolicyRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasOnlyKeys(value, ['schemaVersion', 'policy', 'target']) ||
    !isAutomaticUpdatePolicy(value.policy) ||
    !isManagedServiceTarget(value.target)
  ) {
    throw new TypeError('Invalid managed Runtime Host update policy record');
  }
}

function isAutomaticUpdatePolicy(value: unknown): value is AutomaticUpdatePolicy {
  if (!isRecord(value)) return false;
  if (value.kind === 'channel') {
    return (
      hasOnlyKeys(value, ['kind', 'channel']) &&
      (value.channel === 'latest' || value.channel === 'next')
    );
  }
  return (
    value.kind === 'fixed' &&
    hasOnlyKeys(value, ['kind', 'version']) &&
    typeof value.version === 'string' &&
    isProductReleaseVersion(value.version)
  );
}

function isManagedServiceTarget(value: unknown): value is RuntimeHostManagedServiceTarget {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['serviceId', 'rootPath', 'rootId']) &&
    typeof value.serviceId === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.serviceId) &&
    typeof value.rootId === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.rootId) &&
    typeof value.rootPath === 'string' &&
    isAbsolute(value.rootPath) &&
    value.rootPath.length > 0 &&
    Buffer.byteLength(value.rootPath, 'utf8') <= 4 * 1024 &&
    !/[\u0000-\u001f\u007f]/u.test(value.rootPath)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

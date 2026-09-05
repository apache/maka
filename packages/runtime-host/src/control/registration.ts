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
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeHostRegistration, type HostRegistration } from '../protocol/index.js';

export const RUNTIME_HOST_REGISTRATION_FILE = 'registration.json';
const MAX_REGISTRATION_BYTES = 16 * 1024;

export class RuntimeHostRegistrationError extends Error {
  constructor(
    readonly code: 'invalid_registration' | 'registration_io_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostRegistrationError';
  }
}

export async function readHostRegistration(
  controlDirectory: string,
): Promise<HostRegistration | undefined> {
  const path = join(controlDirectory, RUNTIME_HOST_REGISTRATION_FILE);
  let contents: string;
  try {
    const registrationStat = await lstat(path);
    if (!registrationStat.isFile() || registrationStat.size > MAX_REGISTRATION_BYTES) {
      throw new RuntimeHostRegistrationError(
        'invalid_registration',
        'Runtime Host registration must be a bounded regular file',
      );
    }
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    if (error instanceof RuntimeHostRegistrationError) throw error;
    throw new RuntimeHostRegistrationError(
      'registration_io_failed',
      'Unable to read Runtime Host registration',
      { cause: error },
    );
  }
  try {
    return decodeHostRegistration(JSON.parse(contents) as unknown);
  } catch (error) {
    throw new RuntimeHostRegistrationError(
      'invalid_registration',
      'Runtime Host registration is invalid',
      { cause: error },
    );
  }
}

export async function writeHostRegistration(
  controlDirectory: string,
  registration: HostRegistration,
): Promise<void> {
  const canonical = decodeHostRegistration(registration);
  const path = join(controlDirectory, RUNTIME_HOST_REGISTRATION_FILE);
  const tempPath = join(
    controlDirectory,
    `${RUNTIME_HOST_REGISTRATION_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  let replaced = false;
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(canonical)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    replaced = true;
    await chmod(path, 0o600).catch(() => undefined);
    await syncDirectory(controlDirectory);
  } finally {
    if (!replaced) await unlink(tempPath).catch(() => undefined);
  }
}

export async function removeHostRegistration(
  controlDirectory: string,
  hostEpoch: string,
): Promise<void> {
  let current: HostRegistration | undefined;
  try {
    current = await readHostRegistration(controlDirectory);
  } catch {
    return;
  }
  if (current?.hostEpoch !== hostEpoch) return;
  await unlink(join(controlDirectory, RUNTIME_HOST_REGISTRATION_FILE)).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT')) throw error;
  });
  await syncDirectory(controlDirectory);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

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
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { requireClientInstanceId } from '../protocol/index.js';

const CLIENT_IDENTITY_SCHEMA_VERSION = 1;
const CLIENT_IDENTITY_MAX_BYTES = 512;

interface ClientIdentityDocument {
  readonly schemaVersion: typeof CLIENT_IDENTITY_SCHEMA_VERSION;
  readonly clientInstanceId: string;
}

export async function loadOrCreateRuntimeHostClientInstanceId(path: string): Promise<string> {
  const existing = await readClientIdentity(path);
  if (existing !== undefined) return existing.clientInstanceId;

  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const document: ClientIdentityDocument = {
    schemaVersion: CLIENT_IDENTITY_SCHEMA_VERSION,
    clientInstanceId: randomUUID(),
  };
  const temporaryPath = join(directory, `.runtime-host-client-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, path);
    await syncDirectory(directory);
    return document.clientInstanceId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = await readClientIdentity(path);
    if (winner === undefined) throw new Error('Runtime Host Client identity disappeared');
    return winner.clientInstanceId;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readClientIdentity(path: string): Promise<ClientIdentityDocument | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (bytes.length > CLIENT_IDENTITY_MAX_BYTES) {
    throw new Error('Runtime Host Client identity exceeds its size limit');
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('Runtime Host Client identity is not valid JSON', { cause: error });
  }
  if (!isRecord(value) || value.schemaVersion !== CLIENT_IDENTITY_SCHEMA_VERSION) {
    throw new Error('Runtime Host Client identity has an unsupported schema');
  }
  if (Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'clientInstanceId')) {
    throw new Error('Runtime Host Client identity contains unknown fields');
  }
  return {
    schemaVersion: CLIENT_IDENTITY_SCHEMA_VERSION,
    clientInstanceId: requireClientInstanceId(value.clientInstanceId),
  };
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

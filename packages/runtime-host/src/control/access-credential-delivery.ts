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
import { chmod, open, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  resolveExistingStorageRootControlDirectory,
  resolveStorageRoot,
} from '@maka/storage/root-authority';

const DELIVERY_FILE_PREFIX = 'runtime-host-access-delivery-';
const DELIVERY_FILE_MAX_BYTES = 1024;
const DELIVERY_LIFETIME_MS = 60_000;

interface AccessCredentialDelivery {
  readonly credentialId: string;
  readonly credential: string;
}

export async function createAccessCredentialDelivery(
  controlDirectory: string,
  credentialId: string,
  credential: string,
): Promise<string> {
  const deliveryId = randomUUID();
  const path = deliveryPath(controlDirectory, deliveryId);
  try {
    await writeFile(path, `${JSON.stringify({ credentialId, credential })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (process.platform !== 'win32') await chmod(path, 0o600);
    setTimeout(
      () => void rm(path, { force: true }).catch(() => undefined),
      DELIVERY_LIFETIME_MS,
    ).unref();
    return deliveryId;
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export async function purgeAccessCredentialDeliveries(controlDirectory: string): Promise<void> {
  const entries = await readdir(controlDirectory);
  await Promise.all(
    entries
      .filter((entry) => /^runtime-host-access-delivery-[0-9a-f-]{36}\.json$/u.test(entry))
      .map((entry) => rm(join(controlDirectory, entry), { force: true })),
  );
}

export function discardAccessCredentialDelivery(
  controlDirectory: string,
  deliveryId: string,
): Promise<void> {
  return rm(deliveryPath(controlDirectory, deliveryId), { force: true });
}

export async function consumeAccessCredentialDelivery(
  rootPath: string,
  deliveryId: string,
  expectedCredentialId: string,
): Promise<string> {
  requireDeliveryId(deliveryId);
  const capability = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
  const { controlDirectory } = await resolveExistingStorageRootControlDirectory(capability);
  return consumeAccessCredentialDeliveryFromControlDirectory(
    controlDirectory,
    deliveryId,
    expectedCredentialId,
  );
}

export async function consumeAccessCredentialDeliveryFromControlDirectory(
  controlDirectory: string,
  deliveryId: string,
  expectedCredentialId: string,
): Promise<string> {
  const path = deliveryPath(controlDirectory, deliveryId);
  try {
    const handle = await open(path, 'r');
    let raw: Buffer;
    try {
      const buffer = Buffer.alloc(DELIVERY_FILE_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      if (bytesRead > DELIVERY_FILE_MAX_BYTES) {
        throw new Error('Runtime Host access credential delivery is too large');
      }
      raw = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const delivery = decodeDelivery(JSON.parse(raw.toString('utf8')) as unknown);
    if (delivery.credentialId !== expectedCredentialId) {
      throw new Error('Runtime Host access credential delivery identity does not match');
    }
    return delivery.credential;
  } finally {
    await rm(path, { force: true });
  }
}

function deliveryPath(controlDirectory: string, deliveryId: string): string {
  requireDeliveryId(deliveryId);
  return join(controlDirectory, `${DELIVERY_FILE_PREFIX}${deliveryId}.json`);
}

function requireDeliveryId(deliveryId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(deliveryId)) {
    throw new Error('Invalid Runtime Host access credential delivery identity');
  }
}

function decodeDelivery(value: unknown): AccessCredentialDelivery {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new Error('Invalid Runtime Host access credential delivery');
  }
  if (typeof value.credentialId !== 'string' || typeof value.credential !== 'string') {
    throw new Error('Invalid Runtime Host access credential delivery');
  }
  if (value.credential.length === 0 || value.credential.length > 512) {
    throw new Error('Invalid Runtime Host access credential delivery');
  }
  return { credentialId: value.credentialId, credential: value.credential };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

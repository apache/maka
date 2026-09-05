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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, open, rename, writeFile } from 'node:fs/promises';

// One JSON snapshot of proxy counts. Anything larger is not a checkpoint the
// wrapper writes; it is treated as absent rather than parsed.
export const METERING_CHECKPOINT_LIMIT_BYTES = 64 * 1024;
const MAC_PATTERN = /^[0-9a-f]{64}$/u;

let atomicWriteSequence = 0;

// The checkpoint is read by a different process after this one may have died
// mid-write, so it is renamed into place rather than written in place: a reader
// sees either the previous snapshot or the next one, never a truncated file.
// /logs/agent is created under umask 077, which silently downgrades the
// writeFile mode to 0600. chmod the temporary file before rename so the
// published inode is already 0644; a host that races the rename must not see
// a 0600 file it cannot read.
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${atomicWriteSequence++}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o644 });
  await chmod(temporary, 0o644);
  await rename(temporary, path);
}

// The subject can replace the checkpoint path. Refuse anything that is not a
// bounded regular file so a symlink or a huge write cannot be used as the
// host's usage evidence.
export async function readBoundedRegularFile(
  path: string,
  limitBytes = METERING_CHECKPOINT_LIMIT_BYTES,
): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > limitBytes) return undefined;
    const bytes = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0);
    if (bytesRead !== info.size) return undefined;
    return bytes;
  } finally {
    await handle.close();
  }
}

// The wrapper signs with the relay result token, which is host-issued and
// stripped from the wrapper environment before the subject starts. A subject
// that writes a schema-valid file cannot produce this mac.
export function signMeteringCheckpoint(
  body: Record<string, unknown>,
  secret: string,
): Record<string, unknown> {
  return { ...body, mac: createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex') };
}

export function meteringCheckpointMacMatches(
  record: Record<string, unknown>,
  secret: string,
): boolean {
  const mac = record.mac;
  if (typeof mac !== 'string' || !MAC_PATTERN.test(mac)) return false;
  const body = { ...record };
  delete body.mac;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex'),
    'hex',
  );
  const actual = Buffer.from(mac, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

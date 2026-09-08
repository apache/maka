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

import { open } from 'node:fs/promises';
import {
  externalSessionMatchesQuery,
  type ExternalSessionQuery,
} from '@maka/core/external-session';
import type { ForeignSessionSource } from '@maka/core/foreign-session';

/** Internal catalog row shared by source-specific catalogs and projections. */
export interface ExternalSourceCatalogEntry {
  source: ForeignSessionSource;
  id: string;
  title: string;
  cwd: string;
  updatedAtMs: number;
  createdAtMs?: number;
  gitBranch?: string;
  archived?: boolean;
  transcriptPath: string;
}

export type ExternalSourceCatalogQuery = ExternalSessionQuery;

export function matchesSourceCatalogQuery(
  entry: ExternalSourceCatalogEntry,
  query: ExternalSourceCatalogQuery,
): boolean {
  if (
    !externalSessionMatchesQuery(
      {
        id: entry.id,
        name: entry.title,
        cwd: entry.cwd,
        ...(entry.createdAtMs !== undefined ? { createdAt: entry.createdAtMs } : {}),
        updatedAt: entry.updatedAtMs,
        ...(entry.archived !== undefined ? { archived: entry.archived } : {}),
      },
      query,
    )
  )
    return false;
  return true;
}

export function normalizeSourcePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('External transcript is not a regular file');
    if (metadata.size > maxBytes) throw new Error(`External transcript exceeds ${maxBytes} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`External transcript exceeds ${maxBytes} bytes`);
      chunks.push(buffer.subarray(0, bytesRead));
      if (total === maxBytes) {
        const probe = Buffer.allocUnsafe(1);
        if ((await handle.read(probe, 0, 1, total)).bytesRead > 0) {
          throw new Error(`External transcript exceeds ${maxBytes} bytes`);
        }
        break;
      }
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readUtf8Prefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile())
      throw new Error('External transcript is not a regular file');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readUtf8Tail(
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('External transcript is not a regular file');
    if (metadata.size <= maxBytes) {
      const buffer = Buffer.alloc(metadata.size);
      await handle.read(buffer, 0, metadata.size, 0);
      return { text: buffer.toString('utf8'), truncated: false };
    }
    const start = metadata.size - maxBytes;
    const buffer = Buffer.alloc(maxBytes);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    const firstNewline = text.indexOf('\n');
    return {
      text: firstNewline === -1 ? '' : text.slice(firstNewline + 1),
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}

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

import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeEvalResult, type CellAttempt } from './result.js';
import type { AttemptStore } from './runner.js';

export class FileAttemptStore implements AttemptStore {
  constructor(readonly path: string) {}

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.path, { recursive: true });
    const path = join(this.path, '.writer.lock');
    let lock;
    try {
      lock = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`${path}: experiment already has an active writer`);
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(path);
    }
  }

  async list(cellId: string): Promise<readonly CellAttempt[]> {
    const directory = this.#cellDirectory(cellId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const attempts = await Promise.all(
      names
        .filter((name) => /^\d{6}\.json$/u.test(name))
        .sort()
        .map(async (name) => {
          const attempt = decodeAttempt(JSON.parse(await readFile(join(directory, name), 'utf8')));
          const sequence = Number(name.slice(0, 6));
          if (attempt.cellId !== cellId || attempt.sequence !== sequence) {
            throw new Error('attempt file does not match its immutable identity');
          }
          return attempt;
        }),
    );
    return attempts;
  }

  async append(attempt: CellAttempt): Promise<void> {
    const record = decodeAttempt(attempt);
    const expected = ((await this.list(record.cellId)).at(-1)?.sequence ?? 0) + 1;
    if (record.sequence !== expected) throw new Error(`attempt sequence must be ${expected}`);
    const directory = this.#cellDirectory(record.cellId);
    await mkdir(directory, { recursive: true });
    const finalPath = join(directory, `${String(record.sequence).padStart(6, '0')}.json`);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    const temporary = await open(temporaryPath, 'wx', 0o600);
    try {
      await temporary.writeFile(`${JSON.stringify(record)}\n`);
      await temporary.sync();
      await temporary.close();
      await link(temporaryPath, finalPath);
    } finally {
      await temporary.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  #cellDirectory(cellId: string): string {
    return join(this.path, createHash('sha256').update(cellId).digest('hex'));
  }
}

function decodeAttempt(value: unknown): CellAttempt {
  const attempt = exact(value, 'attempt', [
    'cellId',
    'sequence',
    'startedAt',
    'completedAt',
    'result',
  ]);
  return {
    cellId: nonempty(attempt.cellId, 'attempt.cellId'),
    sequence: positiveInteger(attempt.sequence, 'attempt.sequence'),
    startedAt: nonnegative(attempt.startedAt, 'attempt.startedAt'),
    completedAt: nonnegative(attempt.completedAt, 'attempt.completedAt'),
    result: decodeEvalResult(attempt.result, 'attempt.result'),
  };
}

function exact(value: unknown, where: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    throw new Error(`${where} fields are invalid`);
  }
  return record;
}

function nonempty(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is invalid`);
  return value;
}

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${where} is invalid`);
  return value as number;
}

function nonnegative(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${where} is invalid`);
  return value;
}

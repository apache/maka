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

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WebAccessFile {
  version: 1;
  enabled: boolean;
  passphrase: string;
  totpSecret: string;
  recovery: string[];
  /** Set by confirmTotp. setEnabled(true) requires this to be true. */
  totpConfirmed: boolean;
}

export async function loadWebAccess(path: string): Promise<WebAccessFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<WebAccessFile>;
    if (parsed.version !== 1 || typeof parsed.passphrase !== 'string') return null;
    return {
      version: 1,
      enabled: Boolean(parsed.enabled),
      passphrase: parsed.passphrase,
      totpSecret: typeof parsed.totpSecret === 'string' ? parsed.totpSecret : '',
      recovery: Array.isArray(parsed.recovery)
        ? parsed.recovery.filter((item): item is string => typeof item === 'string')
        : [],
      totpConfirmed: parsed.totpConfirmed === true,
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveWebAccess(path: string, record: WebAccessFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const json = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(path, json, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

export function webAccessPath(userDataDir: string): string {
  return `${userDataDir.replace(/\/$/, '')}/web-access.json`;
}

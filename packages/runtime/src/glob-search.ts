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

import { promises as fs, readdir } from 'node:fs';
import { resolve } from 'node:path';
import { globIterate } from 'glob';

export async function globFiles(input: {
  abortSignal?: AbortSignal;
  cwd: string;
  pattern: string;
  limit?: number;
}): Promise<{ files: string[] }> {
  input.abortSignal?.throwIfAborted();
  let failure: NodeJS.ErrnoException | undefined;
  const directories = new Set([resolve(input.cwd)]);
  function record(error: NodeJS.ErrnoException, path: string): void {
    // Speculative literal components may miss. A directory already admitted by
    // cwd, stat, or enumeration disappearing instead makes this walk incomplete.
    if (directories.has(resolve(path)) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      failure ??= error;
    }
  }
  const files: string[] = [];
  for await (const file of globIterate(input.pattern, {
    cwd: input.cwd,
    signal: input.abortSignal,
    ignore: { childrenIgnored: (entry) => entry.isSymbolicLink() },
    fs: {
      readdir(path, options, callback) {
        readdir(path, options, (error, entries) => {
          if (error) record(error, path as string);
          else
            for (const entry of entries) {
              if (entry.isDirectory()) directories.add(resolve(path as string, entry.name));
            }
          callback(error, entries);
        });
      },
      promises: {
        async lstat(path) {
          try {
            const stat = await fs.lstat(path);
            if (stat.isDirectory()) directories.add(resolve(path as string));
            return stat;
          } catch (error) {
            record(error as NodeJS.ErrnoException, path as string);
            throw error;
          }
        },
      },
    },
  })) {
    input.abortSignal?.throwIfAborted();
    if (failure) throw failure;
    files.push(file);
    if (files.length >= (input.limit ?? 200)) break;
  }
  input.abortSignal?.throwIfAborted();
  if (failure) throw failure;
  return { files };
}

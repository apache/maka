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
import { globIterate } from 'glob';

export async function globFiles(input: {
  cwd: string;
  pattern: string;
  limit?: number;
}): Promise<{ files: string[] }> {
  let failure: NodeJS.ErrnoException | undefined;
  function record(error: NodeJS.ErrnoException): void {
    // Missing literal matches and non-directory pattern components are normal.
    // glob otherwise suppresses I/O failures too, which would hide incomplete walks.
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failure ??= error;
  }
  const files: string[] = [];
  for await (const file of globIterate(input.pattern, {
    cwd: input.cwd,
    ignore: { childrenIgnored: (entry) => entry.isSymbolicLink() },
    fs: {
      readdir(path, options, callback) {
        readdir(path, options, (error, entries) => {
          if (error) record(error);
          callback(error, entries);
        });
      },
      promises: {
        async lstat(path) {
          try {
            return await fs.lstat(path);
          } catch (error) {
            record(error as NodeJS.ErrnoException);
            throw error;
          }
        },
      },
    },
  })) {
    if (failure) throw failure;
    files.push(file);
    if (files.length >= (input.limit ?? 200)) break;
  }
  if (failure) throw failure;
  return { files };
}

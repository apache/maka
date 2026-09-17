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

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * Paths past this many in one request are answered false without a stat. The
 * bound only caps the filesystem work one request can cause: a drop this large
 * can never be sent (MAX_ATTACHMENT_COUNT), and the send path still names an
 * unreadable item it lets through.
 */
export const DIRECTORY_DETECTION_MAX_PATHS = 1024;

/**
 * Answers, for each path the preload read from a dropped or pasted File,
 * whether it is a directory (#5279). Only the preload calls this, with paths
 * taken from File objects the user supplied; the input is still treated as
 * untrusted, and the answer is one boolean per path: a missing, unreadable or
 * non-absolute path is simply not a directory.
 */
export async function detectAttachmentDirectories(
  paths: unknown,
  statPath: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<boolean[]> {
  if (!Array.isArray(paths)) {
    throw new Error('Invalid attachment directory detection request');
  }
  return await Promise.all(
    paths.map(async (path, index) => {
      if (
        index >= DIRECTORY_DETECTION_MAX_PATHS ||
        typeof path !== 'string' ||
        !isAbsolute(path)
      ) {
        return false;
      }
      try {
        return (await statPath(path)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
}

export function registerAttachmentDirectoryDetectionIpc(input: {
  ipcMain: {
    handle(channel: string, listener: (event: unknown, paths: unknown) => Promise<boolean[]>): void;
  };
}): void {
  input.ipcMain.handle('attachments:detectDirectories', (_event, paths) =>
    detectAttachmentDirectories(paths),
  );
}

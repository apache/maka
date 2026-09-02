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

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** CreateFile FILE_FLAG_BACKUP_SEMANTICS — required to open a directory handle on Windows. */
export const WINDOWS_DIRECTORY_OPEN_FLAG = 0x02000000;

/** CreateFile FILE_FLAG_WRITE_THROUGH — flush metadata through the storage stack. */
export const WINDOWS_DIRECTORY_WRITE_THROUGH_FLAG = 0x80000000;

export function windowsDirectoryOpenFlags(): number {
  return constants.O_RDONLY | WINDOWS_DIRECTORY_OPEN_FLAG | WINDOWS_DIRECTORY_WRITE_THROUGH_FLAG;
}

export async function syncWindowsDirectory(path: string): Promise<void> {
  const handle = await open(path, windowsDirectoryOpenFlags());
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

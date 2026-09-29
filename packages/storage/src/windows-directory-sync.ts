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

/**
 * Flush a directory handle on Windows.
 *
 * `handle.sync()` maps to `FlushFileBuffers`, which requires the handle to hold
 * `GENERIC_WRITE`. Node's `open()` takes libuv `uv_fs_open` flags, not raw
 * `CreateFileW` attributes, and libuv derives the access mask from the POSIX
 * mode: `O_RDONLY` yields `FILE_GENERIC_READ` only, so flushing fails with
 * `EPERM`. Reopening read/write (`O_RDWR`) maps to
 * `FILE_GENERIC_READ | FILE_GENERIC_WRITE`, which satisfies the flush.
 *
 * No raw attributes are passed here. libuv already sets
 * `FILE_FLAG_BACKUP_SEMANTICS` unconditionally on every open, which is what
 * makes a directory handle openable at all.
 */
export async function syncWindowsDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

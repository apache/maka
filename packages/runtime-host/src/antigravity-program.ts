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
import { access, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

export type AntigravityProgramFailure = 'executable_unavailable' | 'helper_unavailable';

/** Public diagnostics survive Electron IPC without exposing filesystem error details. */
export class AntigravityProgramError extends Error {
  constructor(readonly failure: AntigravityProgramFailure) {
    super(`Antigravity program: ${failure}`);
  }
}

/** Shared by native program selection and the Host's check/sign-in admission. */
export async function checkAntigravityProgram(executable: string): Promise<{
  executable: string;
  helper: string;
}> {
  const resolved = await checkedFile(executable, 'executable_unavailable');
  const helper = await checkedFile(
    join(dirname(resolved), 'localharness_external'),
    'helper_unavailable',
  );
  return { executable: resolved, helper };
}

async function checkedFile(path: string, failure: AntigravityProgramFailure): Promise<string> {
  try {
    if (!isAbsolute(path)) throw new Error('Absolute path required');
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isFile()) throw new Error('File required');
    await access(resolved, constants.X_OK);
    return resolved;
  } catch {
    throw new AntigravityProgramError(failure);
  }
}

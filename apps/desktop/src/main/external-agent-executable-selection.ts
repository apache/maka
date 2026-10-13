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
import { join } from 'node:path';
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import { checkAntigravityProgram, AntigravityProgramError } from '@maka/runtime-host/antigravity-program';

export async function selectAntigravityExecutable(
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const result = await showOpenDialog({
    // A directory remains selectable when macOS disables the Mach-O binary.
    properties: platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
  });
  const selected = result.canceled ? undefined : result.filePaths[0];
  if (!selected || platform !== 'darwin') return selected;
  const selection = await stat(selected).catch(() => {
    throw new AntigravityProgramError('executable_unavailable');
  });
  const candidate = selection.isDirectory() ? join(selected, 'agy_acp_server.par') : selected;
  const { executable } = await checkAntigravityProgram(candidate);
  return executable;
}

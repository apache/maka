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

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function requireComputerUseLabRoot(env = process.env) {
  const configuredRoot = env.MAKA_CU_AX_MODEL_LAB_ROOT;
  if (typeof configuredRoot !== 'string' || configuredRoot.trim() === '') {
    throw new Error(
      'MAKA_CU_AX_MODEL_LAB_ROOT is required: point it at a local checkout of the Codex CUA Lab fixture',
    );
  }
  if (!isAbsolute(configuredRoot)) {
    throw new Error('MAKA_CU_AX_MODEL_LAB_ROOT must be an absolute path');
  }

  let labRoot;
  try {
    labRoot = realpathSync(configuredRoot);
    if (!statSync(labRoot).isDirectory()) throw new Error('Lab root is not a directory');
  } catch (cause) {
    throw new Error(
      `MAKA_CU_AX_MODEL_LAB_ROOT must point to an existing directory: ${configuredRoot}`,
      { cause },
    );
  }

  const launcherPath = join(labRoot, 'test-app', 'launch.sh');
  try {
    if (!statSync(launcherPath).isFile()) throw new Error('fixture launcher is not a file');
    accessSync(launcherPath, constants.X_OK);
  } catch (cause) {
    throw new Error(
      `MAKA_CU_AX_MODEL_LAB_ROOT must contain an executable test-app/launch.sh: ${launcherPath}`,
      { cause },
    );
  }
  return labRoot;
}

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

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const MAKA_EVAL_BUNDLE_ENV = 'MAKA_EVAL_MAKA_BUNDLE_PATH';

export function configureInstalledEvalBundle(
  environment: NodeJS.ProcessEnv = process.env,
  packageRoot = resolve(import.meta.dirname, '..'),
): void {
  if (Object.hasOwn(environment, MAKA_EVAL_BUNDLE_ENV)) return;
  try {
    if (!statSync(resolve(packageRoot, 'packages/eval')).isDirectory()) return;
  } catch {
    return;
  }
  environment[MAKA_EVAL_BUNDLE_ENV] = packageRoot;
}

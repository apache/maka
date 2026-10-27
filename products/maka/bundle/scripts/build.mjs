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

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { bundle, uiEntries } from '../../../../scripts/plugins/build.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const values = direct
  ? parseArgs({ options: { output: { type: 'string' }, 'ui-entries': { type: 'string' } } }).values
  : {};
const packages = JSON.parse(await readFile(resolve(root, 'package-inputs.json'), 'utf8'));
if (values['ui-entries']) {
  await uiEntries({ packages, output: values['ui-entries'] });
} else {
  await bundle({
    packages,
    output: values.output ? resolve(values.output) : resolve(root, 'dist'),
    composition: resolve(root, 'src/composition.ts'),
  });
}

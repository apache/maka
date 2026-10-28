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

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import declaration from './package.ts';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    maka: { type: 'string', default: 'maka' },
  },
});
if (!values.output) throw Error('Usage: node build.mjs --output NEW_DIRECTORY [--maka EXECUTABLE]');

const source = dirname(fileURLToPath(import.meta.url));
const output = resolve(values.output);
mkdirSync(output);
const build = join(output, 'ui-build');
execFileSync(
  values.maka,
  ['application', 'build-ui', '--entry', join(source, 'index.tsx'), '--output', build],
  { stdio: 'inherit' },
);
const compiled = JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8'));
const packageDirectory = join(output, 'plugin');
mkdirSync(packageDirectory);
copyFileSync(compiled.module, join(packageDirectory, declaration.application.ui.module));
for (const asset of compiled.assets) {
  const target = join(packageDirectory, asset.path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(asset.file, target);
}
writeFileSync(
  join(packageDirectory, 'maka.extension.json'),
  JSON.stringify(declaration, null, 2) + '\n',
);
const reference = JSON.parse(
  execFileSync(values.maka, ['application', 'inspect-package', '--package', packageDirectory], {
    encoding: 'utf8',
    maxBuffer: Infinity,
  }),
);
console.log(JSON.stringify({ package: packageDirectory, reference }));

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

// Authoring utility: writes a new example and checks its exact package with Maka.
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { activate as host } from './host.mjs';

const { values } = parseArgs({
  options: {
    maka: { type: 'string', default: 'maka' },
    output: { type: 'string' },
    target: { type: 'string', default: 'ui' },
  },
});
if (!values.output || !['host', 'ui'].includes(values.target))
  throw Error(
    'Usage: node create.mjs --output NEW_DIRECTORY [--target host|ui] [--maka EXECUTABLE]',
  );
const invoke = (args) =>
  execFileSync(values.maka, ['application', ...args], {
    encoding: 'utf8',
    maxBuffer: Infinity,
  });
const run = (args) => JSON.parse(invoke(args));
const output = resolve(values.output);
mkdirSync(output);
const packageDirectory = join(output, 'plugin');
mkdirSync(packageDirectory);
const source = dirname(fileURLToPath(import.meta.url));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const configuration = { type: 'object', additionalProperties: false };
let application;
if (values.target === 'host') {
  copyFileSync(join(source, 'host.mjs'), join(packageDirectory, 'host.mjs'));
  application = {
    host: {
      implementation: { kind: 'javascript', module: 'host.mjs', realm: 'dedicated' },
      configuration,
      imports: {},
      exports: { Echo: { contract: host().Echo.contract, availability: 'required' } },
    },
  };
} else {
  const entry = join(output, 'ui.tsx');
  copyFileSync(join(source, 'ui.tsx'), entry);
  const build = join(output, 'ui-build');
  invoke(['build-ui', '--entry', entry, '--output', build]);
  const result = JSON.parse(readFileSync(join(build, 'manifest.json'), 'utf8'));
  copyFileSync(result.module, join(packageDirectory, 'ui.js'));
  for (const asset of result.assets) {
    const target = join(packageDirectory, asset.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset.file, target);
  }
  application = {
    ui: {
      module: 'ui.js',
      configuration,
      contributions: {
        counter: { kind: 'panel', title: { fallback: 'Counter' } },
        openCounter: { kind: 'command', title: { fallback: 'Open counter' } },
      },
    },
  };
}
write(join(packageDirectory, 'maka.extension.json'), {
  schemaVersion: 1,
  id: 'example.plugin',
  displayName: values.target === 'host' ? 'Echo service' : 'Counter',
  description: values.target === 'host' ? 'Echo a string.' : 'An NSH counter panel and command.',
  application,
});
const composition = join(output, 'composition.json');
write(composition, {
  instances: {
    example: {
      key: randomUUID(),
      package: {
        source: 'pinned',
        package: run(['inspect-package', '--package', packageDirectory]),
      },
      usePackage: values.target,
    },
  },
});
const packages = [packageDirectory];
run(['check', '--input', composition, '--package', packageDirectory]);
console.log(JSON.stringify({ input: composition, packages }));

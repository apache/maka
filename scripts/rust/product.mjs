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

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cargoBuild } from './cargo.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

/** Build only the NSH compiler, without the product's Host or rendering runtimes. */
export async function uiCompiler(root = repository, env = process.env) {
  const { code, signal, executables } = await cargoBuild(
    ['build', '--locked', '-p', 'maka-ui-build', '--bin', 'maka-ui-build'],
    { cwd: root, env },
  );
  if (code !== 0 || signal) throw new Error(`UI compiler build failed: ${signal ?? code}`);
  const executable = executables.get('maka-ui-build');
  if (!executable) throw new Error('Cargo did not report the Maka UI compiler executable');
  return executable;
}

async function run(args, env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repository,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`Product command failed: ${signal ?? code}`));
    });
  });
}

async function product(action, args) {
  if (!['build', 'test'].includes(action)) throw new Error('Usage: product.mjs build|test');
  const env = { ...process.env, MAKA_UI_BUNDLER: await uiCompiler() };
  await run(['products/maka/bundle/scripts/build.mjs', ...(action === 'build' ? args : [])], env);
  if (action === 'test') {
    const directory = 'products/maka/bundle/tests';
    const tests = (await readdir(join(repository, directory)))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => join(directory, name));
    await run(['--test', '--test-concurrency=1', ...args, ...tests], env);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await product(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

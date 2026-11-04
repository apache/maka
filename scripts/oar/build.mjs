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

import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { build } from 'esbuild';
import { buildRuntime, verifyRuntime, verifyBinaryTarget } from './runtime.mjs';
import { runtimeNotices } from './runtime-notices.mjs';
import { digest } from '../rust/v8-cache.mjs';
import { rustTarget } from '../rust/build-cli.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function bundleWorker(directory) {
  await mkdir(directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const oar = JSON.parse(
    await readFile(join(root, 'node_modules/@botiverse/oar/package.json'), 'utf8'),
  );
  if (manifest.devDependencies['@botiverse/oar'] !== oar.version)
    throw new Error('Installed OAR differs from the exact product pin; run npm ci');
  const entry = join(directory, 'maka-oar-worker.mjs');
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'plugins/agent/oar-executor/worker/main.mjs')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    metafile: true,
    banner: {
      js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
    },
  });
  await writeFile(
    join(directory, 'bundle-inputs.json'),
    JSON.stringify({ oarVersion: oar.version, ...result.metafile }, null, 2),
  );
  return entry;
}

export async function compileWorker(directory, target, { release = false } = {}) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const installed = JSON.parse(
    await readFile(join(root, 'node_modules/deno/package.json'), 'utf8'),
  );
  if (manifest.devDependencies.deno !== installed.version)
    throw new Error('Installed Deno differs from the exact product pin; run npm ci');
  const deno = join(root, 'node_modules/deno/bin.cjs');
  const { stdout: version } = await promisify(execFile)(process.execPath, [deno, '--version']);
  if (!version.startsWith(`deno ${installed.version} `))
    throw new Error('Deno executable differs from the installed product pin');
  target ??= rustTarget();
  const runtime = release ? await buildRuntime(target) : undefined;
  const entry = await bundleWorker(directory);
  const windows = target ? target.includes('windows') : process.platform === 'win32';
  const binary = join(directory, `maka-oar-worker${windows ? '.exe' : ''}`);
  await compileTemplate({
    directory,
    deno,
    entry,
    binary,
    target,
    version: installed.version,
    release,
    runtime,
  });
  if (release) {
    const notices = await runtimeNotices({
      root,
      checkout: runtime.checkout,
      directory: runtime.directory,
      source: runtime.receipt.source,
      target,
      toolchain: runtime.receipt.toolchain,
      metadata: runtime.metadata,
      v8Notices: runtime.v8Notices,
    });
    await copyFile(notices, join(directory, 'runtime-notices.txt'));
  }
  return binary;
}

export async function compileTemplate({
  directory,
  deno,
  entry,
  binary,
  target,
  version,
  release,
  runtime,
}) {
  if (release) await verifyRuntime(runtime, target, version);
  const bundleHash = await digest(entry);
  const flags = [
    'compile',
    '-A',
    '--no-config',
    '--no-lock',
    '--no-npm',
    '--no-remote',
    ...(target ? ['--target', target] : []),
  ];
  const inputs = createHash('sha256')
    .update(
      JSON.stringify({
        bundle: bundleHash,
        deno: version,
        flags,
        runtime: release ? runtime.receipt : null,
      }),
    )
    .digest('hex');
  const receiptPath = join(directory, 'worker-receipt.json');
  async function outputDigest() {
    const output = await stat(binary);
    if (
      !output.isFile() ||
      output.size === 0 ||
      (process.platform !== 'win32' && (output.mode & 0o111) === 0)
    )
      return;
    return digest(binary);
  }
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (
      receipt.inputs === inputs &&
      typeof receipt.worker === 'string' &&
      receipt.worker === (await outputDigest())
    ) {
      if (release) await verifyBinaryTarget(binary, target);
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  await rm(receiptPath, { force: true });
  const env = { ...process.env };
  delete env.DENORT_BIN;
  if (release) env.DENORT_BIN = runtime.binary;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [deno, ...flags, '--output', binary, entry],
    { cwd: directory, maxBuffer: 4 * 1024 * 1024, env },
  );
  process.stderr.write(stdout + stderr);
  if (release) {
    await verifyRuntime(runtime, target, version);
    await verifyBinaryTarget(binary, target);
  }
  if ((await digest(entry)) !== bundleHash)
    throw new Error('Worker bundle changed during compilation');
  const worker = await outputDigest();
  if (!worker) throw new Error('Worker output is not a complete executable');
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        inputs,
        runtime: release ? runtime.receipt : null,
        bundle: bundleHash,
        worker,
      },
      null,
      2,
    ) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', default: join(root, 'target/oar') },
      target: { type: 'string' },
      release: { type: 'boolean', default: false },
      'bundle-only': { type: 'boolean', default: false },
    },
  });
  const output = resolve(values.output);
  console.log(
    values['bundle-only']
      ? await bundleWorker(output)
      : await compileWorker(output, values.target, { release: values.release }),
  );
}

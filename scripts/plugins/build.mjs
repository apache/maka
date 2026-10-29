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

import {
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  realpath,
  mkdtemp,
  copyFile,
  readdir,
  lstat,
} from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, relative, posix, win32 } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { writeProductVersion } from './product-version.mjs';
import { uiCompiler } from '../rust/product.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dependencyRoot = process.env.MAKA_JS_DEPS || repo;
const require = createRequire(resolve(dependencyRoot, 'package.json'));
const { build } = require('esbuild');
const lock = JSON.parse(await readFile(resolve(repo, 'package-lock.json'), 'utf8'));
for (const name of ['esbuild', 'ajv', 'ajv-formats'])
  if (require(`${name}/package.json`).version !== lock.packages[`node_modules/${name}`]?.version)
    throw new Error(`Build dependency does not match repository lockfile: ${name}`);
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const header = (await readFile(resolve(repo, 'packages/plugin-sdk/src/index.ts'), 'utf8'))
  .split('\n\n', 1)[0]
  .trim();

function authoringOptions(packages, output, composition) {
  const entries = Object.fromEntries(
    Object.entries(packages).map(([name, path]) => [
      `packages/${name}`,
      resolve(repo, path, 'package.ts'),
    ]),
  );
  entries.sdk = resolve(repo, 'packages/plugin-sdk/src/index.ts');
  if (composition) entries.composition = resolve(repo, composition);
  return {
    absWorkingDir: repo,
    entryPoints: entries,
    outdir: output,
    bundle: true,
    nodePaths: [resolve(dependencyRoot, 'node_modules')],
    platform: 'node',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'silent',
    metafile: true,
  };
}

async function manifestAt(authoring, name, path) {
  const { default: manifest } = await import(
    pathToFileURL(resolve(authoring, `packages/${name}.mjs`))
  );
  if (manifest.schemaVersion !== 1 || typeof manifest.id !== 'string' || !manifest.application)
    throw new Error(`Invalid package declaration: ${path}`);
  return manifest;
}

function packagePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid package file path: ${path}`);
  return path;
}

async function authoredSource(directory, module, extensions) {
  packagePath(module);
  const stem = module.replace(/\.(?:m?js)$/, '');
  for (const file of [...extensions.map((extension) => stem + extension), module]) {
    const source = resolve(directory, file);
    if (await exists(source)) return realpath(source);
  }
  throw new Error(`No source for ${resolve(directory, module)}`);
}

const uiSource = (directory, module) => authoredSource(directory, module, ['.tsx', '.ts', '.mts']);

export async function uiEntries({ packages, output }) {
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  const temporary = await mkdtemp(resolve(dirname(target), 'maka-ui-entries-'));
  try {
    const authoring = await build(authoringOptions(packages, temporary));
    const entries = new Set();
    for (const [name, path] of Object.entries(packages)) {
      const manifest = await manifestAt(temporary, name, path);
      if (manifest.application.ui)
        entries.add(await uiSource(resolve(repo, path), manifest.application.ui.module));
    }
    const inputs = [
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('./product-version.mjs', import.meta.url)),
      ...Object.keys(authoring.metafile.inputs).map((path) => resolve(repo, path)),
    ];
    await writeFile(
      target,
      JSON.stringify({ entries: [...entries].sort(), inputs: [...new Set(inputs)].sort() }) + '\n',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function compileUi(source, output, cache, executable) {
  if (cache?.[source]) return cache[source];
  if (cache) throw new Error(`Missing precompiled UI entry: ${source}`);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--entry', source, '--output', output], {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`UI bundler failed (${signal ?? code}): ${source}`)),
    );
  });
  return JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
}

async function directory(path) {
  const entry = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (entry && !entry.isDirectory()) await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

async function publish(source, destination, retained = new Set()) {
  await directory(destination);
  const entries = await readdir(source, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of await readdir(destination))
    if (!names.has(entry) && !retained.has(entry))
      await rm(resolve(destination, entry), { recursive: true, force: true });
  for (const entry of entries) {
    if (retained.has(entry.name)) continue;
    const input = resolve(source, entry.name);
    const output = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await publish(input, output);
    } else {
      const bytes = await readFile(input);
      const previous = await lstat(output).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (previous?.isFile() && bytes.equals(await readFile(output))) continue;
      if (previous) await rm(output, { recursive: true, force: true });
      await writeFile(output, bytes);
    }
  }
}

// Product selections are paths to authored packages, not a second declaration catalog.
export async function bundle({ packages, output, composition }) {
  const destination = resolve(output);
  await directory(destination);
  const stage = await mkdtemp(resolve(dirname(destination), 'maka-product-'));
  const uiDirectory = resolve(destination, 'ui-build');
  await directory(uiDirectory);
  try {
    const authoring = await build(
      authoringOptions(packages, resolve(stage, 'authoring'), composition),
    );
    const uiCache = process.env.MAKA_UI_BUNDLE_DIR
      ? JSON.parse(await readFile(resolve(process.env.MAKA_UI_BUNDLE_DIR, 'index.json'), 'utf8'))
      : null;
    const inputs = new Set([
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('./product-version.mjs', import.meta.url)),
      ...Object.keys(authoring.metafile.inputs).map((path) => resolve(repo, path)),
    ]);
    const names = [];
    const uiNames = new Set();
    let compiler = process.env.MAKA_UI_BUNDLER;
    for (const [name, path] of Object.entries(packages)) {
      const source = resolve(repo, path);
      const manifest = await manifestAt(resolve(stage, 'authoring'), name, path);
      const directory = resolve(stage, 'packages', name);
      await mkdir(directory, { recursive: true });
      for (const entry of manifest.application.host ? [manifest.application.host] : []) {
        if (entry.implementation.kind !== 'javascript') continue;
        const module = entry.implementation.module;
        packagePath(module);
        const bundled = await build({
          absWorkingDir: repo,
          entryPoints: [await authoredSource(source, module, ['.ts', '.mts'])],
          outfile: resolve(directory, module),
          bundle: true,
          nodePaths: [resolve(dependencyRoot, 'node_modules')],
          format: 'esm',
          platform: 'neutral',
          target: 'es2022',
          logLevel: 'silent',
          metafile: true,
          banner: { js: header },
        });
        for (const input of Object.keys(bundled.metafile.inputs)) inputs.add(resolve(repo, input));
      }
      if (manifest.application.ui) {
        uiNames.add(name);
        const module = packagePath(manifest.application.ui.module);
        const entry = await uiSource(source, module);
        if (!uiCache && !compiler) compiler = await uiCompiler(repo);
        const compiled = await compileUi(entry, resolve(uiDirectory, name), uiCache, compiler);
        await mkdir(dirname(resolve(directory, module)), { recursive: true });
        await copyFile(compiled.module, resolve(directory, module));
        for (const asset of compiled.assets) {
          const target = resolve(
            directory,
            packagePath(posix.join(posix.dirname(module), asset.path)),
          );
          if (target === resolve(directory, module))
            throw new Error(`UI asset overwrites its module: ${asset.path}`);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(asset.file, target);
        }
        for (const input of compiled.inputs) inputs.add(input);
        inputs.add(entry);
      }
      await writeFile(resolve(directory, 'maka.extension.json'), JSON.stringify(manifest) + '\n');
      names.push(name);
    }
    await writeFile(resolve(stage, 'packages.json'), JSON.stringify(names, null, 2) + '\n');
    await writeFile(
      resolve(stage, 'bundle-inputs.json'),
      JSON.stringify([...inputs].sort()) + '\n',
    );
    // Publish the version last: incomplete builds must not advertise new bytes.
    if (composition) {
      await writeProductVersion(stage, names);
      const version = resolve(destination, 'product-version.txt');
      const previous = await readFile(version).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!previous?.equals(await readFile(resolve(stage, 'product-version.txt'))))
        await rm(version, { force: true });
    }
    await publish(
      stage,
      destination,
      new Set(['ui-build', ...(composition ? ['product-version.txt'] : [])]),
    );
    for (const name of await readdir(uiDirectory))
      if (uiCache || !uiNames.has(name))
        await rm(resolve(uiDirectory, name), { recursive: true, force: true });
    if (composition) {
      const version = await readFile(resolve(stage, 'product-version.txt'));
      const path = resolve(destination, 'product-version.txt');
      const previous = await readFile(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!previous?.equals(version)) await writeFile(path, version);
    }
    console.log(`${names.length} ordinary plugin packages built`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { plugin: { type: 'string' }, output: { type: 'string' } },
  });
  if (!values.plugin || !values.output)
    throw new Error('Usage: build.mjs --plugin plugins/<family>/<package> --output <directory>');
  const plugin = resolve(repo, values.plugin);
  const name = relative(repo, plugin).split('/').at(-1);
  await bundle({ packages: { [name]: plugin }, output: values.output });
}

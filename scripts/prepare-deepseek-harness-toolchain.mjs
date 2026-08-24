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

// Build the DeepSeek Harness toolchain that the Eval external subject mounts
// read-only at /opt/maka-deepseek-harness-toolchain.
//
// The harness's minimal composition pulls in two native modules — node-pty for
// the persistent shell, koffi for the filesystem and session backends — and
// node-pty publishes no Linux prebuild. The toolchain therefore cannot be
// installed on a macOS host and mounted into a linux/amd64 task container; it
// is built inside a matching container, which also supplies the pinned Node.
//
// The fingerprint is the digest of checksums.sha256, which lists every regular
// file this build put in the tree, itself and manifest.json aside. So the
// constant committed in src/toolchain-verification.ts pins the checksum
// manifest, and the manifest pins the content of every file it names. It does
// not pin the tree's closure: verification walks the manifest, not the
// directory, so a file added afterwards is neither named nor refused. That gap
// predates this arm and belongs to verifyToolchainDirectory. A fingerprint
// derived from the build inputs alone would match two different installs of
// the same version, which is exactly the drift a benchmark needs to detect.
//
// `npm i` is not reproducible, so rebuilding produces a new fingerprint. That
// is the point: re-pin it with --write and the change is visible in review.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const identityPath = join(repoRoot, 'packages', 'eval', 'src', 'toolchain-verification.ts');
const manifestDir = join(repoRoot, 'packages', 'eval', 'harbor', 'deepseek-harness-toolchain');

const DEEPSEEK_HARNESS_TOOLCHAIN_SPEC = {
  // The task images are linux/amd64, and the native modules must match them.
  platform: 'linux/amd64',
  node: {
    version: '22.23.2',
    // The build image is the interpreter's provenance: its Node is copied into
    // the toolchain rather than downloaded separately.
    image: 'node:22-bookworm',
    imageDigest: 'sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a',
  },
  deepseekHarness: {
    package: '@deepseek-ai/dsh',
    version: '0.1.0-rc.6',
    entrypoint: 'lib/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  },
};

// Written into the build's own manifest, and the only thing that authorizes
// this script to remove a non-empty --out.
const TOOLCHAIN_BUILD_MARKER = 'maka-eval/prepare-deepseek-harness-toolchain';

async function prepareDeepSeekHarnessToolchain({ outputRoot, write = false } = {}) {
  if (!outputRoot) throw new Error('--out is required');
  const spec = DEEPSEEK_HARNESS_TOOLCHAIN_SPEC;
  const root = resolve(outputRoot);
  // --out is rebuilt from scratch, so it is the one destructive path here. It
  // must name either nothing or a previous build of this toolchain, and never a
  // directory someone works out of.
  for (const reserved of [resolve('/'), repoRoot, process.cwd(), homedir()]) {
    if (root === reserved) throw new Error(`--out must not be ${reserved}`);
  }
  // Only a directory this script produced may be removed. A `manifest.json`
  // entry is not proof of that — plenty of directories have one — so the marker
  // this script writes into its own manifest is what has to be found. An empty
  // directory has nothing to lose and is accepted as it is.
  //
  // What the path is has to be established before what it contains: `readdir`
  // fails the same way for a path that does not exist and for one that is a
  // file, and reading the second as the first would delete the file.
  const target = await stat(root).catch(() => undefined);
  if (target && !target.isDirectory()) throw new Error(`--out must be a directory: ${root}`);
  const existing = target ? await readdir(root) : undefined;
  if (existing && existing.length > 0) {
    const produced = await readFile(join(root, 'manifest.json'), 'utf8')
      .then((raw) => JSON.parse(raw).producedBy === TOOLCHAIN_BUILD_MARKER)
      .catch(() => false);
    if (!produced) {
      throw new Error(`${root} is not empty and was not produced by ${TOOLCHAIN_BUILD_MARKER}`);
    }
  }
  // Both the lockfile and the spec name a harness version. If they disagree the
  // manifest would describe something other than what was installed.
  const lock = JSON.parse(await readFile(join(manifestDir, 'package-lock.json'), 'utf8'));
  const locked = lock.packages?.[`node_modules/${spec.deepseekHarness.package}`]?.version;
  if (locked !== spec.deepseekHarness.version) {
    throw new Error(
      `lockfile pins ${spec.deepseekHarness.package}@${locked}, spec says ${spec.deepseekHarness.version}`,
    );
  }

  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'lib', 'dsh'), { recursive: true });

  const image = `${spec.node.image}@${spec.node.imageDigest}`;
  const install = [
    // The image digest fixes the interpreter; this asserts the version the spec
    // claims for it.
    `test "$(node -v)" = "v${spec.node.version}"`,
    // `npm ci` installs exactly the reviewed lockfile. `npm i` would re-resolve
    // several hundred caret ranges, so two builds of the same harness version
    // could disagree on what they actually installed.
    'cp /manifest/package.json /manifest/package-lock.json .',
    'npm ci >/dev/null 2>&1',
    'node /manifest/patch-subprocess-local.mjs /build',
    // Fail the build here rather than at benchmark time if the native module
    // did not compile.
    'node -e "require(\'node-pty\')"',
    'cp "$(command -v node)" /out/bin/node',
    'cp -R package.json package-lock.json node_modules /out/lib/dsh/',
  ].join(' && ');
  await execFileAsync('docker', [
    'run',
    '--rm',
    '--platform',
    spec.platform,
    '-v',
    `${root}:/out`,
    '-v',
    `${manifestDir}:/manifest:ro`,
    '-w',
    '/build',
    image,
    'sh',
    '-c',
    install,
  ]);

  // The entrypoint path is a shape assumption the spec and the experiment args
  // both depend on; the container's `&&` chain already fails the build if the
  // copies or the native module did not work.
  await requireRegularFile(join(root, spec.deepseekHarness.entrypoint), 'harness entrypoint');

  const checksums = await checksumTree(root);
  await writeFile(join(root, 'checksums.sha256'), checksums, { mode: 0o644 });
  const fingerprint = `sha256:${createHash('sha256').update(checksums).digest('hex')}`;
  // `fingerprint` is provenance here, not identity: verification recomputes it
  // from checksums.sha256 and never reads this file.
  await writeFile(
    join(root, 'manifest.json'),
    `${JSON.stringify({ producedBy: TOOLCHAIN_BUILD_MARKER, fingerprint, spec }, null, 2)}\n`,
    { mode: 0o644 },
  );

  if (write) await recordFingerprint(fingerprint);
  return { root, version: spec.deepseekHarness.version, fingerprint };
}

// Checksums cover every regular file, sorted by toolchain-relative path so the
// digest is stable across builds. manifest.json is written afterwards and is
// therefore not part of its own input.
async function checksumTree(root) {
  const files = [];
  await collect(root, files);
  files.sort();
  const lines = [];
  for (const path of files) lines.push(`${await hashFile(path)}  ${relative(root, path)}`);
  return `${lines.join('\n')}\n`;
}

async function collect(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function requireRegularFile(path, label) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label} is missing at ${path}`);
}

async function recordFingerprint(fingerprint) {
  const source = await readFile(identityPath, 'utf8');
  const pattern =
    /('deepseek-harness': \{\n\s*root: '[^']+',\n\s*version: ')([^']+)(',\n\s*fingerprint: ')([^']+)(')/u;
  if (!pattern.test(source)) throw new Error('deepseek-harness toolchain identity was not found');
  const next = source.replace(
    pattern,
    `$1${DEEPSEEK_HARNESS_TOOLCHAIN_SPEC.deepseekHarness.version}$3${fingerprint}$5`,
  );
  await writeFile(identityPath, next, 'utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const result = await prepareDeepSeekHarnessToolchain({
    outputRoot: outIndex >= 0 ? argv[outIndex + 1] : undefined,
    write: argv.includes('--write'),
  });
  console.log(`${result.root}\n${result.fingerprint}`);
}

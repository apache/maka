#!/usr/bin/env node
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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* Prepare a Rust native Windows helper artifact for local validation. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(
  process.env.MAKA_CU_WINDOWS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'),
);
const outputDirectory = resolve(root, 'apps/desktop/resources/bin/maka-cu-windows');
const output = resolve(outputDirectory, 'maka-cu-windows.exe');

export const REQUIRED_NATIVE_FILES = [];

const PUBLISH_CONTRACT = {
  executor: 'rust-native-windows',
  protocol: 'maka.cu/2',
  runtimeIdentifier: 'win-x64',
  cargoProfile: 'release',
  lto: true,
  staticNativeDependencies: true,
};

/**
 * A local copy or a caller-provided boolean is never enough for distribution.
 * Readiness is tied to the exact bytes and requires release evidence from CI,
 * Authenticode, a clean machine, and a packaged conversation run.
 */
export function resolveWindowsCuDistributionReady(provenance, binarySha256) {
  return Boolean(
    provenance &&
      typeof provenance.executorCommit === 'string' &&
      /^[0-9a-f]{40}$/.test(provenance.executorCommit) &&
      typeof provenance.workflowRun === 'string' &&
      /^[1-9][0-9]*$/.test(provenance.workflowRun) &&
      provenance.artifactSha256 === binarySha256 &&
      typeof binarySha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(binarySha256) &&
      provenance.signature === 'authenticode' &&
      provenance.cleanMachineE2e === true &&
      provenance.packagedConversationE2e === true,
  );
}

export async function inspectWindowsCuArtifact(artifactDirectory) {
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  if (entries.some((entry) => entry.isDirectory())) {
    throw new Error(`Windows helper artifact must be flat: ${artifactDirectory}`);
  }
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  if (!names.includes('maka-cu-windows.exe')) {
    throw new Error(`Windows helper artifact has no maka-cu-windows.exe: ${artifactDirectory}`);
  }
  const binary = await stat(resolve(artifactDirectory, 'maka-cu-windows.exe'));
  if (binary.size < 256 * 1024) {
    throw new Error(
      `Windows helper is not a native release artifact (${binary.size} bytes); ` +
        'build the Rust executor with cargo build --release',
    );
  }
  const missing = REQUIRED_NATIVE_FILES.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`Windows helper artifact is missing: ${missing.join(', ')}`);
  return {
    binaryPath: resolve(artifactDirectory, 'maka-cu-windows.exe'),
    files: await Promise.all(
      names.sort().map(async (name) => {
        const bytes = await readFile(resolve(artifactDirectory, name));
        return {
          name,
          sizeBytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }),
    ),
  };
}

async function publishFromSource(sourceRoot) {
  const manifest = resolve(sourceRoot, 'apps/OpenComputerUseWindows/native/Cargo.toml');
  if (!existsSync(manifest)) {
    throw new Error(`No Rust Windows executor Cargo.toml found under ${sourceRoot}.`);
  }
  const dirty = (await exec('git', ['status', '--porcelain'], { cwd: sourceRoot })).stdout.trim();
  if (dirty) throw new Error(`Windows helper source is dirty: ${sourceRoot}; build from an immutable commit.`);
  const artifact = resolve(sourceRoot, 'artifacts/windows-cu/win-x64');
  await rm(artifact, { recursive: true, force: true });
  await mkdir(artifact, { recursive: true });
  await exec(process.platform === 'win32' ? 'cargo.exe' : 'cargo', [
    'build', '--release', '--manifest-path', manifest,
  ], { cwd: sourceRoot });
  const built = resolve(dirname(manifest), 'target/release/maka-cu-windows-rust.exe');
  if (!existsSync(built)) throw new Error(`Rust release binary was not produced: ${built}`);
  await cp(built, resolve(artifact, 'maka-cu-windows.exe'));
  await inspectWindowsCuArtifact(artifact);
  return artifact;
}

export async function prepareWindowsCuHelper({ source = process.env.MAKA_CU_WINDOWS_SOURCE } = {}) {
  let artifactDirectory = process.env.MAKA_CU_WINDOWS_ARTIFACT;
  if (source) artifactDirectory = await publishFromSource(resolve(source));
  if (!artifactDirectory) artifactDirectory = outputDirectory;
  artifactDirectory = resolve(artifactDirectory);
  await inspectWindowsCuArtifact(artifactDirectory);

  if (artifactDirectory !== outputDirectory) {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    await cp(artifactDirectory, outputDirectory, { recursive: true });
  }
  const finalArtifact = await inspectWindowsCuArtifact(outputDirectory);
  const bytes = await readFile(finalArtifact.binaryPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const provenancePath = process.env.MAKA_CU_WINDOWS_PROVENANCE;
  const provenance = provenancePath
    ? JSON.parse(await readFile(resolve(provenancePath), 'utf8'))
    : {
        executorCommit: source
          ? (await exec('git', ['rev-parse', 'HEAD'], { cwd: resolve(source) })).stdout.trim()
          : undefined,
        workflowRun: undefined,
        artifactSha256: undefined,
        signature: 'unsigned',
        cleanMachineE2e: false,
        packagedConversationE2e: false,
      };
  const manifestPath = resolve(root, 'apps/desktop/bundled-tools.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.windowsCu = {
    repo: 'maka-agent/maka-cu',
    source: source ? 'maka-cu/apps/OpenComputerUseWindows/native' : 'declared-artifact',
    expectedProtocolVersion: 'maka.cu/2',
    binaryName: 'maka-cu-windows.exe',
    binarySizeBytes: bytes.length,
    binarySha256: hash,
    files: finalArtifact.files,
    publishContract: PUBLISH_CONTRACT,
    provenance,
    // There is deliberately no --distribution-ready escape hatch.
    distributionReady: resolveWindowsCuDistributionReady(provenance, hash),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${output} (${hash}, ${bytes.length} bytes); distributionReady=${manifest.windowsCu.distributionReady}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await prepareWindowsCuHelper();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

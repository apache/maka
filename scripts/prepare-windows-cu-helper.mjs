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
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/* Prepare a local Windows helper build from a sibling maka-cu checkout. */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(
  process.env.MAKA_CU_WINDOWS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'),
);
const outputDirectory = resolve(root, 'apps/desktop/resources/bin/maka-cu-windows');
const output = resolve(outputDirectory, 'maka-cu-windows.exe');

// WPF/Windows Desktop keeps these native runtime components beside a
// single-file apphost. Copying only the exe produces the deceptively small
// framework-dependent 151 KB launcher, which exits immediately on a clean
// machine. The managed payload is single-file; these declared native files
// are still required at runtime.
export const REQUIRED_NATIVE_FILES = [
  'D3DCompiler_47_cor3.dll',
  'PenImc_cor3.dll',
  'PresentationNative_cor3.dll',
  'vcruntime140_cor3.dll',
  'wpfgfx_cor3.dll',
];

const PUBLISH_CONTRACT = {
  targetFramework: 'net8.0-windows10.0.22621.0',
  runtimeIdentifier: 'win-x64',
  selfContained: true,
  singleFile: true,
  compression: false,
  trimmed: false,
  debugType: 'embedded',
};

/** Validate a native publish directory before it can enter Desktop resources. */
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
  if (binary.size < 10 * 1024 * 1024) {
    throw new Error(
      `Windows helper is not a self-contained single-file publish (${binary.size} bytes); ` +
        'publish with PublishSingleFile=true and --self-contained true',
    );
  }
  const missing = REQUIRED_NATIVE_FILES.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Windows helper artifact is missing native runtime files: ${missing.join(', ')}`,
    );
  }
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
  const project = resolve(sourceRoot, 'apps/OpenComputerUseWindows/native/MakaCuWindows.csproj');
  const artifact = resolve(sourceRoot, 'artifacts/windows-cu/win-x64');
  await rm(artifact, { recursive: true, force: true });
  await mkdir(artifact, { recursive: true });
  await exec(
    process.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
    [
      'publish',
      project,
      '-c',
      'Release',
      '-r',
      'win-x64',
      '--self-contained',
      'true',
      '-p:PublishSingleFile=true',
      '-p:EnableCompressionInSingleFile=false',
      '-p:PublishTrimmed=false',
      '-p:DebugType=embedded',
      '-o',
      artifact,
    ],
    { cwd: sourceRoot },
  );
  await inspectWindowsCuArtifact(artifact);
  return artifact;
}

export async function prepareWindowsCuHelper({
  source = process.env.MAKA_CU_WINDOWS_SOURCE,
  releaseReady = process.argv.includes('--distribution-ready'),
} = {}) {
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
  const manifestPath = resolve(root, 'apps/desktop/bundled-tools.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.windowsCu = {
    repo: 'sunheyi6/maka-cu',
    source: source ?? 'existing-local-artifact',
    expectedProtocolVersion: 'maka.cu.windows/0',
    binaryName: 'maka-cu-windows.exe',
    binarySizeBytes: bytes.length,
    binarySha256: hash,
    files: finalArtifact.files,
    publishContract: PUBLISH_CONTRACT,
    distributionReady: releaseReady,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Prepared ${output} (${hash}, ${bytes.length} bytes, ${finalArtifact.files.length} files); ` +
      `distributionReady=${releaseReady}`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const source = process.env.MAKA_CU_WINDOWS_SOURCE;
  if (!source && !process.env.MAKA_CU_WINDOWS_ARTIFACT && !existsSync(output)) {
    console.error(
      'Set MAKA_CU_WINDOWS_SOURCE to a maka-cu checkout, MAKA_CU_WINDOWS_ARTIFACT to a declared publish directory, or provide an existing helper artifact.',
    );
    process.exitCode = 2;
  } else {
    try {
      await prepareWindowsCuHelper();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}

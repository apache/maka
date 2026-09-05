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

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export const MAKA_RUNTIME_ARTIFACT_PATH = '/logs/artifacts/maka-runtime-host';
export const MAKA_SUBJECT_STDOUT_PATH = '/logs/artifacts/maka-subject.stdout.txt';
export const MAKA_SUBJECT_STDERR_PATH = '/logs/artifacts/maka-subject.stderr.txt';

interface CapturedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}

export interface MakaRuntimeArtifactManifest {
  readonly schemaVersion: 'maka.eval.runtime_artifacts.v1';
  readonly reason: 'settled' | 'signal';
  readonly capturedAt: number;
  readonly files: readonly CapturedFile[];
}

export async function captureMakaRuntimeArtifacts(input: {
  readonly stateRoot: string;
  readonly destinationRoot: string;
  readonly reason: MakaRuntimeArtifactManifest['reason'];
  readonly now?: () => number;
}): Promise<MakaRuntimeArtifactManifest> {
  const stateRoot = resolve(input.stateRoot);
  const destinationRoot = resolve(input.destinationRoot);
  const stagingRoot = `${destinationRoot}.${process.pid}.${randomUUID()}.tmp`;
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const sourcePath = join(stateRoot, 'runtime.sqlite');
    const destinationPath = join(stagingRoot, 'runtime.sqlite');
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await backup(source, destinationPath);
    } finally {
      source.close();
    }
    const snapshot = new DatabaseSync(destinationPath);
    try {
      snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      snapshot.exec('PRAGMA journal_mode=DELETE');
    } finally {
      snapshot.close();
    }
    await rm(`${destinationPath}-wal`, { force: true });
    await rm(`${destinationPath}-shm`, { force: true });
    await chmod(destinationPath, 0o600);

    for (const name of ['runtime-host-candidate.log', 'runtime-policy.json']) {
      const source = join(stateRoot, name);
      try {
        const metadata = await stat(source);
        if (!metadata.isFile()) continue;
        const destination = join(stagingRoot, name);
        await copyFile(source, destination);
        await chmod(destination, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    const files = await Promise.all(
      ['runtime.sqlite', 'runtime-host-candidate.log', 'runtime-policy.json'].map((name) =>
        describeFile(join(stagingRoot, name), name),
      ),
    );
    const manifest: MakaRuntimeArtifactManifest = {
      schemaVersion: 'maka.eval.runtime_artifacts.v1',
      reason: input.reason,
      capturedAt: (input.now ?? Date.now)(),
      files: files.filter((file): file is CapturedFile => file !== null),
    };
    await writeFile(join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await mkdir(dirname(destinationRoot), { recursive: true, mode: 0o700 });
    await rm(destinationRoot, { recursive: true, force: true });
    await rename(stagingRoot, destinationRoot);
    return manifest;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeMakaArtifactCollectionError(
  destinationRoot: string,
  error: unknown,
): Promise<void> {
  const root = resolve(destinationRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, 'collection-error.json'),
    `${JSON.stringify({
      schemaVersion: 'maka.eval.runtime_artifact_error.v1',
      errorCode: safeErrorCode(error),
      message: safeErrorMessage(error),
    })}\n`,
    { mode: 0o600 },
  );
}

async function describeFile(path: string, name: string): Promise<CapturedFile | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return null;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return {
      path: basename(name),
      bytes: metadata.size,
      sha256: `sha256:${hash.digest('hex')}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function safeErrorCode(error: unknown): string | null {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.from(message).subarray(0, 1024).toString();
}

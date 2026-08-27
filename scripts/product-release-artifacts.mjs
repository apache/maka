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

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyDesktopUpdateArtifacts } from './desktop-update-contract.mjs';
import { readProductReleaseIdentity } from './product-release-identity.mjs';

export function assertExactArtifactSet(actualNames, expectedNames) {
  const actual = [...new Set(actualNames)].sort();
  const expected = [...new Set(expectedNames)].sort();
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = actual.filter((name) => !expectedSet.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
      ...(unexpected.length > 0 ? [`unexpected ${unexpected.join(', ')}`] : []),
    ];
    throw new Error(`Product release artifact set mismatch: ${details.join('; ')}`);
  }
  return expected;
}

async function regularFileNames(directory) {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) {
      throw new Error(`Product release artifact must be a regular file: ${entry.name}`);
    }
    names.push(entry.name);
  }
  return names;
}

export async function stageProductReleaseArtifactGroup({
  sourceDirectory,
  targetDirectory,
  expectedNames,
}) {
  const names = assertExactArtifactSet(await regularFileNames(sourceDirectory), expectedNames);
  await mkdir(targetDirectory, { recursive: true });
  if ((await readdir(targetDirectory)).length > 0) {
    throw new Error(`Product release artifact target directory must be empty: ${targetDirectory}`);
  }
  await Promise.all(
    names.map((name) => copyFile(join(sourceDirectory, name), join(targetDirectory, name))),
  );
  return names;
}

export async function verifyProductReleaseArtifactDirectory(directory, expectedNames) {
  return assertExactArtifactSet(await regularFileNames(directory), expectedNames);
}

function digestFile(path, algorithm = 'sha256') {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}

export async function verifyProductReleaseArtifactIntegrity(directory, identity) {
  await verifyProductReleaseArtifactDirectory(directory, allArtifactNames(identity));
  const checksumNames = allArtifactNames(identity).filter((name) => name.endsWith('.sha256'));
  for (const checksumName of checksumNames) {
    const artifactName = checksumName.slice(0, -'.sha256'.length);
    const source = await readFile(join(directory, checksumName), 'utf8');
    const match = /^([0-9a-f]{64}) {2}([^\r\n]+)\r?\n?$/u.exec(source);
    if (!match || match[2] !== artifactName) {
      throw new Error(`Product release checksum is malformed: ${checksumName}`);
    }
    const digest = await digestFile(join(directory, artifactName));
    if (digest !== match[1]) {
      throw new Error(`Product release checksum does not match: ${artifactName}`);
    }
  }
  await Promise.all([
    verifyDesktopUpdateArtifacts({
      directory,
      metadataName: 'latest-mac.yml',
      version: identity.version,
      artifactName: `Maka-${identity.version}-mac-arm64.zip`,
    }),
    verifyDesktopUpdateArtifacts({
      directory,
      metadataName: 'latest.yml',
      version: identity.version,
      artifactName: identity.exe,
    }),
  ]);
  return allArtifactNames(identity);
}

function allArtifactNames(identity) {
  return Object.values(identity.artifacts).flat();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const identity = await readProductReleaseIdentity();
  if (command === 'stage') {
    const [group, sourceDirectory, targetDirectory] = args;
    const expectedNames = identity.artifacts[group];
    if (!expectedNames || !sourceDirectory || !targetDirectory) {
      throw new Error(
        'usage: product-release-artifacts.mjs stage <group> <source-directory> <target-directory>',
      );
    }
    await stageProductReleaseArtifactGroup({ sourceDirectory, targetDirectory, expectedNames });
    console.log(`Staged exact ${group} product artifacts in ${targetDirectory}`);
  } else if (command === 'verify') {
    const [directory] = args;
    if (!directory) {
      throw new Error('usage: product-release-artifacts.mjs verify <artifact-directory>');
    }
    await verifyProductReleaseArtifactIntegrity(directory, identity);
    console.log(`Verified exact product release artifact bytes in ${directory}`);
  } else if (command === 'list' && args.length === 0) {
    console.log(JSON.stringify(identity.artifacts, null, 2));
  } else {
    throw new Error('usage: product-release-artifacts.mjs <list|stage|verify> ...');
  }
}

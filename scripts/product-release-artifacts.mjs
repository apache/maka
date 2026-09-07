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
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  mergeDesktopUpdateFeeds,
  verifyDesktopUpdateArtifacts,
} from './desktop-update-contract.mjs';
import {
  parseAsfSourceReferenceTag,
  readProductReleaseIdentity,
} from './product-release-identity.mjs';
import { parseProductTag } from './product-release-tag.mjs';

const PRODUCT_RELEASE_WORKFLOW = '.github/workflows/release.yml';
const PUBLICATION_RECORD_KEYS = [
  'schemaVersion',
  'repository',
  'workflow',
  'runId',
  'runAttempt',
  'sourceReferenceTag',
  'sourceCommit',
  'tag',
  'version',
  'assets',
];

export function compareProductReleaseNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertExactArtifactSet(actualNames, expectedNames) {
  const actual = [...new Set(actualNames)].sort(compareProductReleaseNames);
  const expected = [...new Set(expectedNames)].sort(compareProductReleaseNames);
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

/**
 * A macOS client reads one feed covering both architectures, but each
 * architecture is packaged on a runner of its own and can only write a feed
 * naming its own payload. Publication is where the two become the feed clients
 * read; the per-architecture copies are consumed here and never published.
 */
export async function mergeProductReleaseUpdateFeeds(directory, identity) {
  const merged = [];
  for (const feed of identity.updateFeeds) {
    if (!feed.mergedFrom) continue;
    await mergeDesktopUpdateFeeds({
      sourcePaths: feed.mergedFrom.map((name) => join(directory, name)),
      outputPath: join(directory, feed.name),
    });
    await Promise.all(feed.mergedFrom.map((name) => rm(join(directory, name))));
    merged.push(feed.name);
  }
  return merged;
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

export async function productReleaseArtifactRecords(directory, names) {
  return Promise.all(
    [...names].sort(compareProductReleaseNames).map(async (name) => {
      const path = join(directory, name);
      const [details, digest] = await Promise.all([stat(path), digestFile(path)]);
      if (!details.isFile()) {
        throw new Error(`Product release artifact must be a regular file: ${name}`);
      }
      return { name, size: details.size, digest: `sha256:${digest}` };
    }),
  );
}

export async function verifyProductReleaseArtifactIntegrity(directory, identity) {
  await verifyProductReleaseArtifactDirectory(directory, identity.releaseAssets);
  const checksumNames = identity.releaseAssets.filter((name) => name.endsWith('.sha256'));
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
  await Promise.all(
    identity.updateFeeds.map((feed) =>
      verifyDesktopUpdateArtifacts({
        directory,
        metadataName: feed.name,
        version: identity.version,
        artifactNames: feed.advertised,
      }),
    ),
  );
  return identity.releaseAssets;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys)) {
    throw new Error(`${label} fields are invalid`);
  }
}

function assertRunIdentity(runId, runAttempt) {
  if (
    typeof runId !== 'string' ||
    typeof runAttempt !== 'string' ||
    !/^[1-9]\d*$/u.test(runId) ||
    !/^[1-9]\d*$/u.test(runAttempt)
  ) {
    throw new Error('Product release run ID and attempt must be positive integers');
  }
}

function assertRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Product repository must be an exact owner/name; found ${repository}`);
  }
}

export function assertProductReleasePublicationRecord(record, expected = {}) {
  exactKeys(record, PUBLICATION_RECORD_KEYS, 'Product release publication record');
  if (record.schemaVersion !== 2) {
    throw new Error('Unsupported product release publication record');
  }
  assertRepository(record.repository);
  if (record.workflow !== PRODUCT_RELEASE_WORKFLOW) {
    throw new Error(`Product release workflow must be ${PRODUCT_RELEASE_WORKFLOW}`);
  }
  assertRunIdentity(record.runId, record.runAttempt);
  if (!/^[0-9a-f]{40}$/u.test(record.sourceCommit)) {
    throw new Error('Product release source commit must be an exact SHA');
  }
  const product = parseProductTag(record.tag);
  const source = parseAsfSourceReferenceTag(record.sourceReferenceTag);
  if (
    product.prerelease.length > 0 ||
    record.version !== product.version ||
    source.version !== product.version
  ) {
    throw new Error('Product release publication identity is inconsistent');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && record[key] !== value) {
      throw new Error(`Product release publication record ${key} does not match`);
    }
  }
  if (!Array.isArray(record.assets) || record.assets.length === 0) {
    throw new Error('Product release publication record must contain assets');
  }
  const names = new Set();
  for (const asset of record.assets) {
    exactKeys(asset, ['name', 'size', 'digest'], 'Product release publication asset');
    if (
      typeof asset.name !== 'string' ||
      asset.name.length === 0 ||
      asset.name.includes('/') ||
      asset.name.includes('\\') ||
      names.has(asset.name) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)
    ) {
      throw new Error('Product release publication asset is invalid');
    }
    names.add(asset.name);
  }
  if (
    JSON.stringify(record.assets.map(({ name }) => name)) !==
    JSON.stringify([...names].sort(compareProductReleaseNames))
  ) {
    throw new Error('Product release publication assets must be sorted');
  }
  return record;
}

export async function createProductReleasePublicationRecord({
  artifactDirectory,
  identity,
  repository,
  runId,
  runAttempt,
}) {
  assertRepository(repository);
  assertRunIdentity(runId, runAttempt);
  await verifyProductReleaseArtifactIntegrity(artifactDirectory, identity);
  return assertProductReleasePublicationRecord({
    schemaVersion: 2,
    repository,
    workflow: PRODUCT_RELEASE_WORKFLOW,
    runId,
    runAttempt,
    sourceReferenceTag: identity.sourceReferenceTag,
    sourceCommit: identity.sourceCommit,
    tag: identity.tag,
    version: identity.version,
    assets: await productReleaseArtifactRecords(artifactDirectory, identity.releaseAssets),
  });
}

export async function verifyProductReleasePublicationRecord({
  artifactDirectory,
  record,
  expected,
}) {
  assertProductReleasePublicationRecord(record, expected);
  const names = record.assets.map(({ name }) => name);
  await verifyProductReleaseArtifactDirectory(artifactDirectory, names);
  const actual = await productReleaseArtifactRecords(artifactDirectory, names);
  if (JSON.stringify(actual) !== JSON.stringify(record.assets)) {
    throw new Error('Product release artifacts do not match the immutable publication record');
  }
  return record;
}

export async function readProductReleasePublicationRecord(path, expected) {
  let record;
  try {
    record = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error('Product release publication record is not valid JSON', { cause: error });
  }
  return assertProductReleasePublicationRecord(record, expected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'stage') {
    const identity = await readProductReleaseIdentity();
    const [group, sourceDirectory, targetDirectory] = args;
    const expectedNames = identity.artifacts[group];
    if (!expectedNames || !sourceDirectory || !targetDirectory) {
      throw new Error(
        'usage: product-release-artifacts.mjs stage <group> <source-directory> <target-directory>',
      );
    }
    await stageProductReleaseArtifactGroup({ sourceDirectory, targetDirectory, expectedNames });
    console.log(`Staged exact ${group} product artifacts in ${targetDirectory}`);
  } else if (command === 'merge-feeds') {
    const identity = await readProductReleaseIdentity();
    const [directory] = args;
    if (!directory) {
      throw new Error('usage: product-release-artifacts.mjs merge-feeds <artifact-directory>');
    }
    const merged = await mergeProductReleaseUpdateFeeds(directory, identity);
    console.log(`Merged the per-architecture update feeds into ${merged.join(', ')}`);
  } else if (command === 'verify') {
    const identity = await readProductReleaseIdentity();
    const [directory] = args;
    if (!directory) {
      throw new Error('usage: product-release-artifacts.mjs verify <artifact-directory>');
    }
    await verifyProductReleaseArtifactIntegrity(directory, identity);
    console.log(`Verified exact product release artifact bytes in ${directory}`);
  } else if (command === 'record') {
    const identity = await readProductReleaseIdentity();
    const [directory, recordPath, repository, runId, runAttempt] = args;
    if (!directory || !recordPath || !repository || !runId || !runAttempt) {
      throw new Error(
        'usage: product-release-artifacts.mjs record <artifact-directory> <record-path> <owner/repository> <run-id> <run-attempt>',
      );
    }
    const record = await createProductReleasePublicationRecord({
      artifactDirectory: directory,
      identity,
      repository,
      runId,
      runAttempt,
    });
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
    console.log(`Recorded immutable product release evidence in ${recordPath}`);
  } else if (command === 'inspect-record') {
    const [recordPath, repository, tag, sourceCommit, sourceReferenceTag, runId, runAttempt] = args;
    if (
      !recordPath ||
      !repository ||
      !tag ||
      !sourceCommit ||
      !sourceReferenceTag ||
      !runId ||
      !runAttempt
    ) {
      throw new Error(
        'usage: product-release-artifacts.mjs inspect-record <record-path> <owner/repository> <tag> <source-commit> <source-reference-tag> <run-id> <run-attempt>',
      );
    }
    await readProductReleasePublicationRecord(recordPath, {
      repository,
      tag,
      sourceCommit,
      sourceReferenceTag,
      runId,
      runAttempt,
    });
    console.log(`Verified immutable product release evidence for ${tag}`);
  } else if (command === 'list' && args.length === 0) {
    const identity = await readProductReleaseIdentity();
    console.log(JSON.stringify(identity.releaseAssets, null, 2));
  } else {
    throw new Error(
      'usage: product-release-artifacts.mjs <list|stage|merge-feeds|verify|record|inspect-record> ...',
    );
  }
}

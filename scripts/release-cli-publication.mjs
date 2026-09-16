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

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CLI_RELEASE_ARTIFACT_LIMITS } from './release-cli-artifact-policy.mjs';
import {
  assertProductNightlyVersion,
  parseProductNightlyVersion,
  parseProductReleaseVersion,
} from './release-version.mjs';

const PACKAGE_NAME = 'maka-agent';
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const REPOSITORY = 'apache/maka';
const PUBLICATION_WORKFLOW_PATH = '.github/workflows/npm-publication.yml';
const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;
const RELEASE_RECORD_KEYS = [
  'schemaVersion',
  'packageName',
  'version',
  'productTag',
  'distTag',
  'tarball',
  'sha256',
  'checksum',
  'inventory',
  'source',
  'publisher',
];

export function parseCliReleaseVersion(version) {
  const { prerelease } = parseProductReleaseVersion(version);
  if (prerelease.length > 0) {
    throw new Error('Formal CLI releases must use a stable product version');
  }
  return {
    version,
    distTag: 'latest',
    tarball: `${PACKAGE_NAME}-${version}.tgz`,
  };
}

export function parseCliNightlyVersion(version, productVersion) {
  assertProductNightlyVersion(version, productVersion);
  return {
    version,
    distTag: 'nightly',
    tarball: `${PACKAGE_NAME}-${version}.tgz`,
  };
}

export function validateRegistryChannels({ releaseVersion, releaseDistTag, distTags }) {
  if (!distTags || typeof distTags !== 'object' || Array.isArray(distTags)) {
    throw new Error('Registry package metadata has no valid dist-tags');
  }
  if (distTags[releaseDistTag] !== releaseVersion) {
    throw new Error(`Registry dist-tag ${releaseDistTag} does not point to ${releaseVersion}`);
  }
}

export function prepareNightlyRelease({ repoRoot, releaseDirectory, expectedVersion }) {
  const cliManifest = readJson(join(repoRoot, 'packages/cli/package.json'), 'CLI manifest');
  if (cliManifest.name !== PACKAGE_NAME) {
    throw new Error(`CLI package name must be ${PACKAGE_NAME}`);
  }
  const identity = parseCliNightlyVersion(expectedVersion, cliManifest.version);
  const candidate = validateCandidateFiles(releaseDirectory, identity);
  return { ...identity, tarballPath: candidate.tarballPath, sha256: candidate.sha256 };
}

export function prepareStageRelease({
  repoRoot,
  releaseDirectory,
  expectedVersion,
  productTag,
  sourceSha,
  publisherSha,
  runId,
  runAttempt,
  repository,
  workflowPath,
}) {
  const cliManifest = readJson(join(repoRoot, 'packages/cli/package.json'), 'CLI manifest');
  if (cliManifest.name !== PACKAGE_NAME) {
    throw new Error(`CLI package name must be ${PACKAGE_NAME}`);
  }
  const identity = parseCliReleaseVersion(expectedVersion);
  if (productTag !== `v${identity.version}`) {
    throw new Error(`Product tag ${productTag} does not match ${identity.version}`);
  }
  validateProductSource({ sourceSha, repository });
  validatePublisherIdentity({
    publisherSha,
    runId,
    runAttempt,
    workflowPath,
  });
  const candidate = validateCandidateFiles(releaseDirectory, identity);
  const record = {
    schemaVersion: 4,
    packageName: PACKAGE_NAME,
    ...identity,
    productTag,
    sha256: candidate.sha256,
    checksum: `${identity.tarball}.sha256`,
    inventory: `${identity.tarball}.files.json`,
    source: {
      repository,
      commit: sourceSha,
    },
    publisher: {
      workflow: workflowPath,
      commit: publisherSha,
      runId,
      runAttempt,
    },
  };
  writeFileSync(join(releaseDirectory, 'release.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  });
  return { record, tarballPath: candidate.tarballPath };
}

export function validateStageRun({ releaseDirectory, expectedVersion, run }) {
  const record = loadReleaseRecord(releaseDirectory);
  if (expectedVersion !== record.version) {
    throw new Error(
      `Finalization version confirmation ${expectedVersion} does not match ${record.version}`,
    );
  }
  if (
    !run ||
    String(run.id) !== record.publisher.runId ||
    String(run.run_attempt) !== record.publisher.runAttempt ||
    run.path !== record.publisher.workflow ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== 'main' ||
    run.head_sha !== record.publisher.commit ||
    run.conclusion !== 'success' ||
    run.head_repository?.full_name !== record.source.repository
  ) {
    throw new Error(
      'Release record does not belong to the exact successful main-branch stage workflow run',
    );
  }
  return record;
}

export async function fetchRegistryRelease({
  releaseDirectory,
  registryDirectory,
  fetchImpl = fetch,
}) {
  const record = loadReleaseRecord(releaseDirectory);
  const versionUrl = `${REGISTRY_ORIGIN}/${PACKAGE_NAME}/${encodeURIComponent(record.version)}`;
  const metadata = await fetchJson(
    fetchImpl,
    versionUrl,
    'package version metadata',
    'application/json',
  );
  if (metadata.name !== PACKAGE_NAME || metadata.version !== record.version) {
    throw new Error('Registry package identity does not match the staged release');
  }
  const tags = await fetchJson(fetchImpl, `${REGISTRY_ORIGIN}/${PACKAGE_NAME}`, 'package metadata');
  validateRegistryChannels({
    releaseVersion: record.version,
    releaseDistTag: record.distTag,
    distTags: tags['dist-tags'],
  });
  const tarballUrl = parseRegistryTarballUrl(metadata.dist?.tarball, record.tarball);
  const response = await fetchImpl(tarballUrl, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`Registry tarball request failed with status ${response.status}`);
  }
  const bytes = await readBoundedBytes(
    response,
    CLI_RELEASE_ARTIFACT_LIMITS.compressedBytes,
    'Registry tarball exceeds the reviewed compressed size limit',
  );
  const sha256 = digest('sha256', bytes, 'hex');
  if (sha256 !== record.sha256) {
    throw new Error('Registry tarball does not match the staged release checksum');
  }
  if (metadata.dist?.integrity !== `sha512-${digest('sha512', bytes, 'base64')}`) {
    throw new Error('Registry tarball does not match its published integrity');
  }
  if (metadata.dist?.shasum !== digest('sha1', bytes, 'hex')) {
    throw new Error('Registry tarball does not match its published shasum');
  }

  mkdirSync(registryDirectory, { recursive: true, mode: 0o755 });
  const tarballPath = join(registryDirectory, record.tarball);
  writeFileSync(tarballPath, bytes, { flag: 'wx', mode: 0o644 });
  for (const name of [record.checksum, record.inventory, 'release.json']) {
    copyFileSync(join(releaseDirectory, name), join(registryDirectory, name));
  }
  return { ...record, tarballPath, sha256 };
}

export async function resolveRegistryNightlyPredecessor({ fetchImpl = fetch } = {}) {
  const packageMetadata = await fetchJson(
    fetchImpl,
    `${REGISTRY_ORIGIN}/${PACKAGE_NAME}`,
    'package metadata',
  );
  const version = packageMetadata?.['dist-tags']?.nightly;
  parseProductNightlyVersion(version);

  const versionMetadata = await fetchJson(
    fetchImpl,
    `${REGISTRY_ORIGIN}/${PACKAGE_NAME}/${encodeURIComponent(version)}`,
    'package version metadata',
    'application/json',
  );
  if (versionMetadata.name !== PACKAGE_NAME || versionMetadata.version !== version) {
    throw new Error('Registry Nightly identity does not match its dist-tag');
  }

  const tarball = `${PACKAGE_NAME}-${version}.tgz`;
  const tarballUrl = parseRegistryTarballUrl(versionMetadata.dist?.tarball, tarball);
  const integrity = parseSha512Integrity(versionMetadata.dist?.integrity);
  return {
    version,
    tarballUrl,
    integrity,
  };
}

export async function assertRegistryNightlyPredecessor({
  expectedVersion,
  expectedTarballUrl,
  expectedIntegrity,
  fetchImpl = fetch,
}) {
  const current = await resolveRegistryNightlyPredecessor({ fetchImpl });
  if (
    current.version !== expectedVersion ||
    current.tarballUrl !== expectedTarballUrl ||
    current.integrity !== expectedIntegrity
  ) {
    throw new Error(
      `Qualified npm Nightly predecessor ${expectedVersion} is no longer current; found ${current.version}`,
    );
  }
  return current;
}

export function validateSignatureAudit({ releaseDirectory, audit }) {
  const record = loadReleaseRecord(releaseDirectory);
  if (!Array.isArray(audit?.invalid) || !Array.isArray(audit?.missing)) {
    throw new Error('npm signature audit did not return its bounded result arrays');
  }
  if (audit.invalid.length > 0 || audit.missing.length > 0) {
    throw new Error('npm signature audit found invalid or missing signatures');
  }
  const verified = Array.isArray(audit.verified) ? audit.verified : [];
  const own = verified.find(
    (entry) => entry?.name === PACKAGE_NAME && entry.version === record.version,
  );
  if (!own?.attestations?.provenance) {
    throw new Error(
      `npm signature audit did not include verified provenance for ${record.version}`,
    );
  }
  const statements = (own.attestationBundles ?? []).map(parseProvenanceStatement);
  if (!statements.some((statement) => matchesReleaseProvenance(statement, record))) {
    throw new Error(`npm signature audit provenance does not match ${record.productTag}`);
  }
  return record;
}

export function prepareSignatureAuditTree({ releaseDirectory, auditDirectory }) {
  const record = loadReleaseRecord(releaseDirectory);
  const packageDirectory = join(auditDirectory, 'node_modules', PACKAGE_NAME);
  mkdirSync(packageDirectory, { recursive: true, mode: 0o755 });
  writeJson(
    join(auditDirectory, 'package.json'),
    {
      name: 'maka-cli-signature-audit',
      private: true,
      dependencies: { [PACKAGE_NAME]: record.version },
    },
    0o644,
  );
  writeJson(
    join(packageDirectory, 'package.json'),
    { name: PACKAGE_NAME, version: record.version },
    0o644,
  );
  return record;
}

function loadReleaseRecord(releaseDirectory) {
  const record = readJson(join(releaseDirectory, 'release.json'), 'release record');
  exactKeys(record, RELEASE_RECORD_KEYS, 'release record');
  if (record.schemaVersion !== 4 || record.packageName !== PACKAGE_NAME) {
    throw new Error('Unsupported CLI release record');
  }
  const identity = parseCliReleaseVersion(record.version);
  const derivedFields = {
    productTag: `v${identity.version}`,
    distTag: identity.distTag,
    tarball: identity.tarball,
    checksum: `${identity.tarball}.sha256`,
    inventory: `${identity.tarball}.files.json`,
  };
  for (const [key, expected] of Object.entries(derivedFields)) {
    if (record[key] !== expected) throw new Error(`Release record ${key} is inconsistent`);
  }
  if (!/^[0-9a-f]{64}$/u.test(record.sha256)) {
    throw new Error('Release record sha256 is invalid');
  }
  exactKeys(record.source, ['repository', 'commit'], 'release source');
  validateProductSource({
    sourceSha: record.source.commit,
    repository: record.source.repository,
  });
  exactKeys(record.publisher, ['workflow', 'commit', 'runId', 'runAttempt'], 'release publisher');
  validatePublisherIdentity({
    publisherSha: record.publisher.commit,
    runId: record.publisher.runId,
    runAttempt: record.publisher.runAttempt,
    workflowPath: record.publisher.workflow,
  });
  const candidate = validateCandidateFiles(releaseDirectory, identity);
  if (candidate.sha256 !== record.sha256) {
    throw new Error('Release record checksum does not match the candidate');
  }
  return record;
}

function validateCandidateFiles(releaseDirectory, identity) {
  const tarballPath = join(releaseDirectory, identity.tarball);
  const bytes = readFileSync(tarballPath);
  if (bytes.length > CLI_RELEASE_ARTIFACT_LIMITS.compressedBytes) {
    throw new Error('CLI release candidate exceeds the reviewed compressed size limit');
  }
  const checksum = readFileSync(`${tarballPath}.sha256`, 'utf8');
  const match = /^([0-9a-f]{64}) {2}([^\r\n]+)\r?\n?$/u.exec(checksum);
  if (!match || match[2] !== identity.tarball) {
    throw new Error('CLI release candidate checksum sidecar is malformed');
  }
  const sha256 = digest('sha256', bytes, 'hex');
  if (match[1] !== sha256) {
    throw new Error('CLI release candidate checksum does not match');
  }
  const inventory = readJson(`${tarballPath}.files.json`, 'CLI release file inventory');
  if (!Array.isArray(inventory)) throw new Error('CLI release file inventory must be an array');
  return { tarballPath, sha256 };
}

function validateProductSource({ sourceSha, repository }) {
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error('Release source SHA is invalid');
  if (repository !== REPOSITORY) throw new Error(`Release repository must be ${REPOSITORY}`);
}

function validatePublisherIdentity({ publisherSha, runId, runAttempt, workflowPath }) {
  if (!/^[0-9a-f]{40}$/u.test(publisherSha)) throw new Error('Release publisher SHA is invalid');
  if (!/^[1-9]\d*$/u.test(runId)) throw new Error('Release workflow run ID is invalid');
  if (!/^[1-9]\d*$/u.test(runAttempt)) throw new Error('Release workflow run attempt is invalid');
  if (workflowPath !== PUBLICATION_WORKFLOW_PATH) {
    throw new Error(`Release workflow must be ${PUBLICATION_WORKFLOW_PATH}`);
  }
}

function parseProvenanceStatement(attestation) {
  if (attestation?.predicateType !== 'https://slsa.dev/provenance/v1') return null;
  const envelope = attestation.bundle?.dsseEnvelope;
  if (
    envelope?.payloadType !== 'application/vnd.in-toto+json' ||
    typeof envelope.payload !== 'string'
  ) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function matchesReleaseProvenance(statement, record) {
  const repository = `https://github.com/${record.source.repository}`;
  const ref = 'refs/heads/main';
  const definition = statement?.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const dependencies = definition?.resolvedDependencies;
  const invocationId = `${repository}/actions/runs/${record.publisher.runId}/attempts/${record.publisher.runAttempt}`;
  return (
    statement?._type === 'https://in-toto.io/Statement/v1' &&
    statement?.predicateType === 'https://slsa.dev/provenance/v1' &&
    definition?.buildType ===
      'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1' &&
    workflow?.repository === repository &&
    workflow?.ref === ref &&
    workflow?.path === record.publisher.workflow &&
    Array.isArray(dependencies) &&
    dependencies.some(
      (dependency) =>
        dependency?.uri === `git+${repository}@${ref}` &&
        dependency?.digest?.gitCommit === record.publisher.commit,
    ) &&
    definition?.internalParameters?.github?.event_name === 'workflow_dispatch' &&
    statement?.predicate?.runDetails?.builder?.id?.startsWith(
      'https://github.com/actions/runner/',
    ) &&
    statement?.predicate?.runDetails?.metadata?.invocationId === invocationId
  );
}

async function fetchJson(fetchImpl, url, label, accept = 'application/vnd.npm.install-v1+json') {
  const response = await fetchImpl(url, {
    headers: { accept },
    redirect: 'error',
    signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Registry ${label} request failed with status ${response.status}`);
  const bytes = await readBoundedBytes(
    response,
    4 * 1024 * 1024,
    `Registry ${label} exceeds the bounded response size`,
  );
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Registry ${label} is not valid JSON`, { cause: error });
  }
}

async function readBoundedBytes(response, limit, errorMessage) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > limit) {
    throw new Error(errorMessage);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(errorMessage);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function parseRegistryTarballUrl(value, expectedName) {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    throw new Error('Registry package metadata has no valid tarball URL');
  }
  const url = new URL(value);
  if (
    url.origin !== REGISTRY_ORIGIN ||
    url.username ||
    url.password ||
    basename(url.pathname) !== expectedName
  ) {
    throw new Error('Registry package metadata points outside the npm registry release path');
  }
  return url.href;
}

function parseSha512Integrity(value) {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) {
    throw new Error('Registry package metadata has no valid SHA-512 integrity');
  }
  const encoded = value.slice('sha512-'.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength !== 64 || bytes.toString('base64') !== encoded) {
    throw new Error('Registry package metadata has no valid SHA-512 integrity');
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid`, { cause: error });
  }
}

function writeJson(path, value, mode) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode });
}

function digest(algorithm, bytes, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function appendOutputs(path, values) {
  for (const [name, value] of Object.entries(values)) {
    const text = String(value);
    if (!/^[a-z_]+$/u.test(name) || /[\r\n]/u.test(text)) {
      throw new Error('Unsafe GitHub Actions output');
    }
    appendFileSync(path, `${name}=${text}\n`, 'utf8');
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare-stage' && args.length === 10) {
    const [
      releaseDirectory,
      expectedVersion,
      productTag,
      sourceSha,
      publisherSha,
      runId,
      runAttempt,
      repository,
      workflowPath,
      output,
    ] = args;
    const result = prepareStageRelease({
      repoRoot: resolve(import.meta.dirname, '..'),
      releaseDirectory: resolve(releaseDirectory),
      expectedVersion,
      productTag,
      sourceSha,
      publisherSha,
      runId,
      runAttempt,
      repository,
      workflowPath,
    });
    appendOutputs(output, {
      version: result.record.version,
      dist_tag: result.record.distTag,
      tarball: result.tarballPath,
    });
    return;
  }
  if (command === 'prepare-nightly' && args.length === 3) {
    const [releaseDirectory, expectedVersion, output] = args;
    const result = prepareNightlyRelease({
      repoRoot: resolve(import.meta.dirname, '..'),
      releaseDirectory: resolve(releaseDirectory),
      expectedVersion,
    });
    appendOutputs(output, {
      version: result.version,
      dist_tag: result.distTag,
      tarball: result.tarballPath,
    });
    return;
  }
  if (command === 'validate-stage-run' && (args.length === 3 || args.length === 4)) {
    const [releaseDirectory, runPath, expectedVersion, output] = args;
    const record = validateStageRun({
      releaseDirectory: resolve(releaseDirectory),
      expectedVersion,
      run: readJson(resolve(runPath), 'stage workflow run'),
    });
    if (output) {
      appendOutputs(output, {
        product_tag: record.productTag,
        source_commit: record.source.commit,
        version: record.version,
      });
    }
    return;
  }
  if (command === 'prepare-audit' && args.length === 2) {
    const [releaseDirectory, auditDirectory] = args;
    prepareSignatureAuditTree({
      releaseDirectory: resolve(releaseDirectory),
      auditDirectory: resolve(auditDirectory),
    });
    return;
  }
  if (command === 'fetch-registry' && args.length === 2) {
    const [releaseDirectory, registryDirectory] = args;
    await fetchRegistryRelease({
      releaseDirectory: resolve(releaseDirectory),
      registryDirectory: resolve(registryDirectory),
    });
    return;
  }
  if (command === 'resolve-nightly-predecessor' && args.length === 1) {
    const [output] = args;
    const predecessor = await resolveRegistryNightlyPredecessor();
    appendOutputs(output, {
      version: predecessor.version,
      tarball_url: predecessor.tarballUrl,
      integrity: predecessor.integrity,
    });
    return;
  }
  if (command === 'assert-nightly-predecessor' && args.length === 3) {
    const [expectedVersion, expectedTarballUrl, expectedIntegrity] = args;
    await assertRegistryNightlyPredecessor({
      expectedVersion,
      expectedTarballUrl,
      expectedIntegrity,
    });
    return;
  }
  if (command === 'validate-audit' && args.length === 2) {
    const [releaseDirectory, auditPath] = args;
    validateSignatureAudit({
      releaseDirectory: resolve(releaseDirectory),
      audit: readJson(resolve(auditPath), 'npm signature audit'),
    });
    return;
  }
  throw new Error(
    `Usage: release-cli-publication.mjs <prepare-stage|prepare-nightly|prepare-audit|validate-stage-run|fetch-registry|resolve-nightly-predecessor|assert-nightly-predecessor|validate-audit> ...`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

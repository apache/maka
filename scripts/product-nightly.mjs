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

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertProductNightlyVersion, parseProductReleaseVersion } from './release-version.mjs';

export const PRODUCT_NIGHTLY_WORKFLOW = '.github/workflows/npm-publication.yml';
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicationRecordKeys = [
  'schemaVersion',
  'repository',
  'workflowPath',
  'runId',
  'runAttempt',
  'sourceCommit',
  'version',
].sort();

export function productNightlyIdentity({ productVersion, date, runNumber, sourceCommit }) {
  if (parseProductReleaseVersion(productVersion).prerelease.length > 0) {
    throw new Error('Product Nightly requires a stable checked-in product version');
  }
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error('Product Nightly requires a valid build date');
  }
  if (typeof runNumber !== 'string' || !/^[1-9]\d*$/u.test(runNumber)) {
    throw new Error('Product Nightly requires a positive run number');
  }
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('Product Nightly requires an exact source commit');
  }

  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  const version = `${productVersion}-dev.${day}.${runNumber}`;
  assertProductNightlyVersion(version, productVersion);
  return {
    version,
    sourceCommit,
  };
}

export function createProductNightlyPublicationRecord({
  productVersion,
  version,
  sourceCommit,
  repository,
  workflowPath,
  runId,
  runAttempt,
}) {
  assertProductNightlyVersion(version, productVersion);
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('Product Nightly publication requires an exact source commit');
  }
  if (repository !== 'apache/maka') {
    throw new Error('Product Nightly publication requires the apache/maka repository');
  }
  if (workflowPath !== PRODUCT_NIGHTLY_WORKFLOW) {
    throw new Error(`Product Nightly publication requires ${PRODUCT_NIGHTLY_WORKFLOW}`);
  }
  if (typeof runId !== 'string' || !/^[1-9]\d*$/u.test(runId)) {
    throw new Error('Product Nightly publication requires a positive workflow run ID');
  }
  if (typeof runAttempt !== 'string' || !/^[1-9]\d*$/u.test(runAttempt)) {
    throw new Error('Product Nightly publication requires a positive workflow run attempt');
  }
  return {
    schemaVersion: 1,
    repository,
    workflowPath,
    runId,
    runAttempt,
    sourceCommit,
    version,
  };
}

export function validateProductNightlyPublicationRecord(record, expected) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Product Nightly publication record must be an object');
  }
  const actualKeys = Object.keys(record).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(publicationRecordKeys)) {
    throw new Error('Product Nightly publication record has an unexpected shape');
  }
  const canonical = createProductNightlyPublicationRecord({
    productVersion: expected.productVersion,
    version: record.version,
    sourceCommit: record.sourceCommit,
    repository: record.repository,
    workflowPath: record.workflowPath,
    runId: record.runId,
    runAttempt: record.runAttempt,
  });
  if (record.schemaVersion !== canonical.schemaVersion) {
    throw new Error('Product Nightly publication record schema version is unsupported');
  }
  for (const key of ['repository', 'workflowPath', 'runId', 'runAttempt', 'sourceCommit']) {
    if (canonical[key] !== expected[key]) {
      throw new Error(`Product Nightly publication record ${key} does not match its workflow run`);
    }
  }
  return canonical;
}

async function main(args, environment = process.env) {
  const [command, ...rest] = args;
  const productManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  if (command === 'identity' && rest.length === 0) {
    const identity = productNightlyIdentity({
      productVersion: productManifest.version,
      date: new Date(environment.NIGHTLY_BUILD_DATE ?? Date.now()),
      runNumber: environment.GITHUB_RUN_NUMBER,
      sourceCommit: environment.GITHUB_SHA,
    });
    if (environment.GITHUB_OUTPUT) {
      await appendFile(
        environment.GITHUB_OUTPUT,
        `version=${identity.version}\nsource_commit=${identity.sourceCommit}\n`,
        'utf8',
      );
    }
    console.log(JSON.stringify(identity));
    return;
  }
  if (command === 'write-publication-record' && rest.length === 7) {
    const [output, version, sourceCommit, runId, runAttempt, repository, workflowPath] = rest;
    const record = createProductNightlyPublicationRecord({
      productVersion: productManifest.version,
      version,
      sourceCommit,
      repository,
      workflowPath,
      runId,
      runAttempt,
    });
    await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return;
  }
  if (command === 'inspect-publication-record' && rest.length === 7) {
    const [input, runId, runAttempt, repository, workflowPath, sourceCommit, output] = rest;
    const record = validateProductNightlyPublicationRecord(
      JSON.parse(await readFile(input, 'utf8')),
      {
        productVersion: productManifest.version,
        repository,
        workflowPath,
        runId,
        runAttempt,
        sourceCommit,
      },
    );
    await appendFile(
      output,
      `version=${record.version}\nsource_commit=${record.sourceCommit}\n`,
      'utf8',
    );
    return;
  }
  throw new Error(
    'usage: product-nightly.mjs identity | write-publication-record <output> <version> <source-commit> <run-id> <run-attempt> <repository> <workflow-path> | inspect-publication-record <input> <run-id> <run-attempt> <repository> <workflow-path> <source-commit> <output>',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}

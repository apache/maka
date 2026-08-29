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
import {
  assertProductNightlyAdvances,
  assertProductNightlyVersion,
  parseProductReleaseVersion,
} from './release-version.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
  const version = `${productVersion}-dev.${runNumber}.${day}`;
  assertProductNightlyVersion(version, productVersion);
  return {
    version,
    sourceCommit,
  };
}

export function parseProductNightlyVersionFile(source, productVersion) {
  if (typeof source !== 'string' || !source.endsWith('\n') || source.slice(0, -1).includes('\n')) {
    throw new Error(
      'Product Nightly version file must contain exactly one newline-terminated line',
    );
  }
  const version = source.slice(0, -1);
  return assertProductNightlyVersion(version, productVersion);
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
  if (command === 'write-version' && rest.length === 2) {
    const [output, version] = rest;
    assertProductNightlyVersion(version, productManifest.version);
    await writeFile(output, `${version}\n`, 'utf8');
    return;
  }
  if (command === 'inspect-version' && rest.length === 2) {
    const [input, output] = rest;
    const version = parseProductNightlyVersionFile(
      await readFile(input, 'utf8'),
      productManifest.version,
    );
    await appendFile(output, `version=${version}\n`, 'utf8');
    return;
  }
  if (command === 'assert-channel-advance' && (rest.length === 1 || rest.length === 2)) {
    const [candidateVersion, currentVersion = ''] = rest;
    assertProductNightlyAdvances(candidateVersion, currentVersion, productManifest.version);
    return;
  }
  throw new Error(
    'usage: product-nightly.mjs identity | write-version <output> <version> | inspect-version <input> <output> | assert-channel-advance <candidate-version> [current-version]',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}

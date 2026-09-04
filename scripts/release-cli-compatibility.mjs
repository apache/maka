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

import { readFileSync } from 'node:fs';

const EPOCH_DECLARATION =
  /^export const RUNTIME_HOST_COMPATIBILITY_EPOCH\s*=\s*(\d+)(?:\s+as const)?\s*;/gmu;
const RELEASE_IDENTITY_KEYS = [
  'schemaVersion',
  'product',
  'version',
  'sourceCommit',
  'compatibilityEpoch',
];

export function resolveMakaReleaseIdentity({ version, sourceCommit, sourcePath }) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('Maka release identity requires a non-empty version');
  }
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('Maka release identity requires an exact 40-character source commit SHA');
  }
  return {
    schemaVersion: 1,
    product: 'Maka',
    version,
    sourceCommit,
    compatibilityEpoch: readRuntimeHostCompatibilityEpoch(sourcePath),
  };
}

export function assertMakaReleaseIdentity({ expected, actual, label = 'Maka release identity' }) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new Error(`${label} is missing`);
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...RELEASE_IDENTITY_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} has an unexpected shape`);
  }
  for (const key of RELEASE_IDENTITY_KEYS) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label} mismatch for ${key}: expected ${JSON.stringify(expected[key])}, found ${JSON.stringify(actual[key])}`,
      );
    }
  }
  return actual;
}

export function readRuntimeHostCompatibilityEpoch(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const matches = [...content.matchAll(EPOCH_DECLARATION)];
  if (matches.length !== 1) {
    throw new Error(`Runtime Host compatibility epoch declaration is not unique in ${filePath}`);
  }
  const epoch = Number(matches[0][1]);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error(`Runtime Host compatibility epoch is invalid in ${filePath}`);
  }
  return epoch;
}

export function assertRuntimeHostCompatibilityEpoch({ sourcePath, packagedPath }) {
  const sourceEpoch = readRuntimeHostCompatibilityEpoch(sourcePath);
  const packagedEpoch = readRuntimeHostCompatibilityEpoch(packagedPath);
  if (sourceEpoch !== packagedEpoch) {
    throw new Error(
      `Runtime Host compatibility epoch mismatch: source ${sourceEpoch} (${sourcePath}) vs packaged ${packagedEpoch} (${packagedPath})`,
    );
  }
  return { sourceEpoch, packagedEpoch };
}

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

// Sanity floor for a freshly refreshed model-metadata snapshot. sync-model-metadata.mjs
// already refuses a refresh that would remove any previously committed projection path
// (see assertProjectionDoesNotShrink), which enforces a per-provider, per-model floor.
// This check adds the one thing that misses: a models.dev response that is well-formed
// per-provider but truncated or empty overall (e.g. an outage returning a near-empty but
// schema-valid payload) would still pass that check if it happened to contain no removals
// relative to an already-small snapshot. A floor on the total model count catches that.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROVIDERS } from './sync-model-metadata.mjs';

const DEFAULT_SNAPSHOT = 'scripts/model-metadata/models-dev-api.snapshot.json';
// Set comfortably below the committed count at the time this floor was introduced
// (1871 models across 47 providers) so ordinary upstream churn never trips it, while
// a mostly-empty response still does.
const MIN_TOTAL_MODELS = 1500;

export async function main(argv = process.argv) {
  const snapshotPath = option('--snapshot', argv) ?? DEFAULT_SNAPSHOT;
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const metadata = snapshot?.projection?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${snapshotPath} has no projection.metadata object`);
  }

  const requiredProviders = Object.keys(PROVIDERS);
  const missingProviders = requiredProviders.filter(
    (providerType) => !metadata[providerType] || Object.keys(metadata[providerType]).length === 0,
  );
  if (missingProviders.length > 0) {
    throw new Error(
      `model-metadata snapshot is missing models for required provider(s): ${missingProviders.join(', ')}`,
    );
  }

  const totalModels = Object.values(metadata).reduce(
    (sum, models) => sum + Object.keys(models).length,
    0,
  );
  if (totalModels < MIN_TOTAL_MODELS) {
    throw new Error(
      `model-metadata snapshot has ${totalModels} total models, below the floor of ${MIN_TOTAL_MODELS}; ` +
        'this likely means the models.dev response was truncated or degraded',
    );
  }

  console.log(
    `model-metadata sanity floor passed: ${totalModels} models across ${requiredProviders.length} providers`,
  );
}

function option(name, argv) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

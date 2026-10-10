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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const INVENTORY_ARTIFACTS = Object.freeze({
  markdown: 'docs/astryx-surface-file-inventory.md',
  paths: 'docs/astryx-surface-file-inventory.paths',
});

function nonEmptyLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function describePaths(label, paths) {
  if (paths.length === 0) return [];
  return [`${label} (${paths.length}):\n  ${paths.slice(0, 20).join('\n  ')}`];
}

export function comparePathArtifact(rendered, committedPaths) {
  if (committedPaths === rendered.paths) return [];

  const expected = new Set(rendered.files);
  const actual = new Set(nonEmptyLines(committedPaths));
  return [
    '.paths does not match generator output',
    ...describePaths(
      'on disk but not in .paths',
      rendered.files.filter((file) => !actual.has(file)),
    ),
    ...describePaths(
      'in .paths but not on disk',
      [...actual].filter((file) => !expected.has(file)),
    ),
  ];
}

export function inventoryDrift(rendered, committed) {
  return [
    ...comparePathArtifact(rendered, committed.paths),
    ...(committed.markdown === rendered.markdown
      ? []
      : [`${INVENTORY_ARTIFACTS.markdown} does not match generator output`]),
  ];
}

export function readCommittedInventory(repoRoot, readFile = readFileSync) {
  const paths = join(repoRoot, INVENTORY_ARTIFACTS.paths);
  const markdown = join(repoRoot, INVENTORY_ARTIFACTS.markdown);
  const missing = [paths, markdown].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `missing inventory artifacts (${missing.map((file) => file).join(', ')}) — run: npm run astryx:surface-inventory:write`,
    );
  }
  return {
    markdown: readFile(markdown, 'utf8'),
    paths: readFile(paths, 'utf8'),
  };
}

export function formatInventoryFailure(details) {
  return `astryx surface inventory is stale; run: npm run astryx:surface-inventory:write\n${details.map((detail) => `- ${detail}`).join('\n')}`;
}

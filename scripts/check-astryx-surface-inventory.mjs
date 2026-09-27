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

/** Verify that both committed inventory artifacts equal a fresh render. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertNoAstryxBlockers,
  renderAstryxSurfaceInventory,
} from './generate-astryx-surface-inventory.mjs';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
// One pre-existing reasoning disclosure owns button semantics on a div. Keep
// its full diagnostic as the baseline: another control, even in the same file,
// changes the occurrence count and fails admission.
const legacyBlockerBaseline = new Map([
  [
    'packages/ui/src/astryx-chat-reasoning.tsx',
    'hand-written interactive `<div>` (1 occurrence); use Astryx `Button`; do not hand-write controls from raw elements or custom control CSS (API Use-the-System)',
  ],
]);

export function inventoryDrift(rendered, committed) {
  const pathMessages = comparePathArtifact(rendered, committed.paths);
  const markdownMessages =
    committed.markdown === rendered.markdown
      ? []
      : ['docs/astryx-surface-file-inventory.md does not match generator output'];
  return [...pathMessages, ...markdownMessages];
}

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

function comparePathArtifact(rendered, committedPaths) {
  if (committedPaths === rendered.paths) return [];
  const expected = new Set(rendered.files);
  const actual = new Set(nonEmptyLines(committedPaths));
  const missing = rendered.files.filter((file) => !actual.has(file));
  const extra = [...actual].filter((file) => !expected.has(file));
  return [
    '.paths does not match generator output',
    ...describePaths('on disk but not in .paths', missing),
    ...describePaths('in .paths but not on disk', extra),
  ];
}

export function runInventoryCheck(repoRoot = root) {
  const currentPathsFile = join(repoRoot, 'docs/astryx-surface-file-inventory.paths');
  const currentMarkdownFile = join(repoRoot, 'docs/astryx-surface-file-inventory.md');
  if (!existsSync(currentPathsFile) || !existsSync(currentMarkdownFile)) {
    throw new Error('missing inventory artifacts — run: npm run astryx:surface-inventory:write');
  }

  const rendered = renderAstryxSurfaceInventory(repoRoot);
  assertNoAstryxBlockers(rendered, legacyBlockerBaseline);
  const details = inventoryDrift(rendered, {
    markdown: readFileSync(currentMarkdownFile, 'utf8'),
    paths: readFileSync(currentPathsFile, 'utf8'),
  });
  return { details, rendered };
}

function reportInventoryCheck(result, output = console) {
  if (result.details.length === 0) {
    output.log(
      `astryx surface inventory coverage: ok (${result.rendered.files.length} files, ${result.rendered.excluded.length} exclusions)`,
    );
    return 0;
  }
  output.error(
    `astryx surface inventory is stale; run: npm run astryx:surface-inventory:write\n${result.details.map((detail) => `- ${detail}`).join('\n')}`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = reportInventoryCheck(runInventoryCheck());
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

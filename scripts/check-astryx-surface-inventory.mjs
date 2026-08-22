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

/**
 * Coverage gate: committed inventory artifacts match a fresh generator run.
 *
 * These files are generated. Hand-editing one half (or leaving a deleted
 * path in the Markdown table) is the failure mode. Regenerating and
 * comparing bytes is the invariant — not a second, hand-written file list.
 *
 * Run: npm run astryx:surface-inventory
 * Fix: npm run astryx:surface-inventory:write
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAstryxSurfaceInventory } from './generate-astryx-surface-inventory.mjs';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const pathsFile = join(root, 'docs/astryx-surface-file-inventory.paths');
const mdFile = join(root, 'docs/astryx-surface-file-inventory.md');

function main() {
  if (!existsSync(pathsFile) || !existsSync(mdFile)) {
    console.error('missing inventory artifacts — run: npm run astryx:surface-inventory:write');
    process.exit(1);
  }

  const rendered = renderAstryxSurfaceInventory(root);
  const committedMd = readFileSync(mdFile, 'utf8');
  const committedPaths = readFileSync(pathsFile, 'utf8');
  const mdDrift = committedMd !== rendered.markdown;
  const pathsDrift = committedPaths !== rendered.paths;

  if (!mdDrift && !pathsDrift) {
    console.log(
      `astryx surface inventory coverage: ok (${rendered.files.length} files, ${rendered.excluded.length} exclusions)`,
    );
    return;
  }

  const committedPathSet = new Set(
    committedPaths
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const generatedPathSet = new Set(rendered.files);
  const missing = rendered.files.filter((file) => !committedPathSet.has(file));
  const extra = [...committedPathSet].filter((file) => !generatedPathSet.has(file));

  const details = [];
  if (pathsDrift) {
    details.push('.paths does not match generator output');
    if (missing.length) {
      details.push(
        `on disk but not in .paths (${missing.length}):\n  ${missing.slice(0, 20).join('\n  ')}`,
      );
    }
    if (extra.length) {
      details.push(
        `in .paths but not on disk (${extra.length}):\n  ${extra.slice(0, 20).join('\n  ')}`,
      );
    }
  }
  if (mdDrift) {
    details.push('docs/astryx-surface-file-inventory.md does not match generator output');
  }

  console.error(
    `astryx surface inventory is stale; run: npm run astryx:surface-inventory:write\n${details.map((line) => `- ${line}`).join('\n')}`,
  );
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}

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

import { readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedFilesBetween, planTests } from './ci-test-plan.mjs';
import { collectWorkspaceSourceClosure } from './workspace-source-closure.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));
const desktopE2eRoot = 'apps/desktop/e2e';

const SELECTION_AUTHORITY_FILES = new Set([
  'apps/desktop/e2e/playwright.config.ts',
  'scripts/desktop-e2e-test-selection.mjs',
  'scripts/workspace-source-closure.mjs',
]);

function normalizePath(path) {
  return path.split(sep).join('/').replace(/^\.\//u, '');
}

export function listDesktopE2eSpecs(repoRoot = defaultRepoRoot) {
  const root = resolve(repoRoot, desktopE2eRoot);
  return readdirSync(root, { recursive: true })
    .filter((path) => path.endsWith('.spec.ts'))
    .map((path) => normalizePath(relative(repoRoot, resolve(root, path))))
    .sort();
}

export async function collectDesktopE2eSpecClosures(specs, repoRoot = defaultRepoRoot) {
  const closures = new Map();
  for (const spec of specs) {
    closures.set(spec, new Set(await collectWorkspaceSourceClosure([spec], repoRoot)));
  }
  return closures;
}

export async function selectDesktopE2eSpecs(changedFiles, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const files = [...new Set(changedFiles.map(normalizePath).filter(Boolean))];
  const specs = options.specs ?? listDesktopE2eSpecs(repoRoot);
  const plan = planTests(files, { repoRoot, forceFull: options.forceFull });
  if (!plan.e2e) return [];
  if (plan.full || files.some((path) => SELECTION_AUTHORITY_FILES.has(path))) return specs;

  const closures = options.closures ?? (await collectDesktopE2eSpecClosures(specs, repoRoot));
  return specs.filter((spec) => files.some((path) => closures.get(spec)?.has(path)));
}

function parseArgs(args) {
  const parsed = { base: undefined, forceFull: false, head: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--full') parsed.forceFull = true;
    else if (arg === '--base') parsed.base = args[++index];
    else if (arg === '--head') parsed.head = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.forceFull && (!parsed.base || !parsed.head)) {
    throw new Error('Expected --full or both --base <sha> and --head <sha>');
  }
  return parsed;
}

async function main(args) {
  const parsed = parseArgs(args);
  const changedFiles = parsed.forceFull ? [] : changedFilesBetween(parsed.base, parsed.head);
  const specs = await selectDesktopE2eSpecs(changedFiles, { forceFull: parsed.forceFull });
  const workspaceSpecs = specs.map((path) => path.slice('apps/desktop/'.length));
  process.stdout.write(workspaceSpecs.length > 0 ? `${workspaceSpecs.join('\n')}\n` : '');
  process.stderr.write(`Desktop e2e selection: ${specs.length} spec files\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

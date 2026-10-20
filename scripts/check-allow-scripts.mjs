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

// Drift guard for the `allowScripts` map in the root package.json.
//
// npm >= 11.6 asks for an explicit approval before running a dependency's
// lifecycle scripts, keyed by exact `name@version`. The map only helps while
// it matches package-lock.json: this PR chain started because two keyed
// versions trailed the lockfile after routine bumps, and the optional
// Darwin-only fsevents was never listed at all. This check fails on any of:
//
//   1. a lockfile entry with `hasInstallScript` that the map does not key
//      (optionality is not an exemption — fsevents is exactly the case);
//   2. a map key whose `name@version` no longer matches a lockfile entry
//      that carries install scripts (the stale-version failure mode);
//   3. a map value that is not a boolean, which silently means neither
//     "approve" nor "deny" to the gate.
//
// It does not judge the true/false decisions themselves — only that every
// script-carrying package has one, and that nothing in the map is dead.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);
const args = process.argv.slice(2);

function readOption(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

const packageJsonPath = readOption('--package') ?? path.join(repoRoot, 'package.json');
const lockfilePath = readOption('--lock') ?? path.join(repoRoot, 'package-lock.json');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const lock = JSON.parse(readFileSync(lockfilePath, 'utf8'));

const allowScripts = packageJson.allowScripts ?? null;
if (allowScripts === null || typeof allowScripts !== 'object' || Array.isArray(allowScripts)) {
  console.error('package.json has no allowScripts object; nothing to guard.');
  process.exit(1);
}

// A lockfile key is "node_modules/..." with the dependency name as the last
// `node_modules/` segment (scoped names span two path parts).
function nameFromLockKey(lockKey) {
  const marker = lockKey.lastIndexOf('node_modules/');
  return marker === -1 ? lockKey : lockKey.slice(marker + 'node_modules/'.length);
}

// Split an exact `name@version` key on its final '@' so scoped names survive.
function splitAllowKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

const problems = [];
const lockEntries = new Map(); // name@version -> lockfile key
for (const [lockKey, entry] of Object.entries(lock.packages ?? {})) {
  if (lockKey === '') continue; // the root project is not a dependency of itself
  if (!entry.hasInstallScript) continue;
  const exact = `${nameFromLockKey(lockKey)}@${entry.version}`;
  if (lockEntries.has(exact)) {
    problems.push(
      `lockfile carries ${exact} at two paths: ${lockEntries.get(exact)} and ${lockKey}`,
    );
    continue;
  }
  lockEntries.set(exact, lockKey);
}

for (const [exact] of lockEntries) {
  if (!(exact in allowScripts)) {
    const entry = lock.packages[lockEntries.get(exact)] ?? {};
    const where = entry.optional
      ? ` (optional${entry.os?.length ? `, os: ${entry.os.join('/')}` : ''})`
      : '';
    problems.push(`missing: ${exact}${where} has install scripts but no allowScripts decision`);
  }
}

const keyedExact = new Set();
for (const [key, value] of Object.entries(allowScripts)) {
  if (typeof value !== 'boolean') {
    problems.push(
      `invalid: "${key}" maps to ${JSON.stringify(value)}; the gate expects true or false`,
    );
    continue;
  }
  const split = splitAllowKey(key);
  if (!split || !split.version) {
    problems.push(`invalid: "${key}" is not an exact name@version key`);
    continue;
  }
  keyedExact.add(key);
  if (!lockEntries.has(key)) {
    problems.push(
      `stale: "${key}" matches no lockfile entry with install scripts (version bumped, or scripts gone)`,
    );
  }
}

if (problems.length > 0) {
  console.error(`allowScripts is out of sync with ${path.basename(lockfilePath)}:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\n${keyedExact.size} keyed / ${lockEntries.size} script-carrying packages. Fix package.json's allowScripts map.`,
  );
  process.exit(1);
}

console.log(
  `allowScripts covers all ${lockEntries.size} install-script packages with exact name@version keys.`,
);

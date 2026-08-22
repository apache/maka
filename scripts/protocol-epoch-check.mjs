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

// Merge-result guard for the Runtime Host compatibility epoch (#3313).
//
// Two branches that each bump the epoch write the same text to the same line,
// so git's three-way merge resolves them without a conflict and two
// incompatible protocols end up advertising one epoch. This check runs on the
// PR merge result and compares it with the synthetic merge's first parent: the
// current base branch. It fails when anything under the protocol directory
// changed while the epoch still equals that parent — exactly the state a silent
// same-number merge produces.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHeader, classifyPath } from './asf-license-headers.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

export const EPOCH_FILE = 'packages/runtime-host/src/protocol/index.ts';
export const PROTOCOL_DIR = 'packages/runtime-host/src/protocol/';

const EPOCH_PATTERN = /^export const RUNTIME_HOST_COMPATIBILITY_EPOCH = (\d+) as const;$/gm;

export function extractCompatibilityEpoch(source) {
  const matches = [...source.matchAll(EPOCH_PATTERN)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one RUNTIME_HOST_COMPATIBILITY_EPOCH declaration in ${EPOCH_FILE}, found ${matches.length}`,
    );
  }
  return Number(matches[0][1]);
}

export function evaluateEpochCheck({ baseEpoch, headEpoch, changedProtocolFiles }) {
  if (headEpoch < baseEpoch) {
    return {
      ok: false,
      reason:
        `RUNTIME_HOST_COMPATIBILITY_EPOCH went backward: ${baseEpoch} -> ${headEpoch}. ` +
        `The epoch never decreases — a peer that saw ${baseEpoch} would admit an ` +
        `incompatible protocol. Bump it forward instead, even for a revert.`,
    };
  }
  if (changedProtocolFiles.length > 0 && headEpoch === baseEpoch) {
    return {
      ok: false,
      reason:
        `Protocol files changed but RUNTIME_HOST_COMPATIBILITY_EPOCH is still ${baseEpoch}, ` +
        `the current base parent's value. Same-number bumps on sibling branches merge without ` +
        `a git conflict (#3313), so every protocol change must land with an epoch the current ` +
        `base has not seen: rebase onto current main and set the epoch past ${baseEpoch}. ` +
        `Changed files:\n${changedProtocolFiles.map((file) => `  ${file}`).join('\n')}`,
    };
  }
  return {
    ok: true,
    reason:
      changedProtocolFiles.length > 0
        ? `Protocol changed and the epoch moved: ${baseEpoch} -> ${headEpoch}.`
        : `No protocol changes against the current base parent (epoch ${headEpoch}).`,
  };
}

function git(args, exec = execFileSync) {
  return exec('git', args, { cwd: defaultRepoRoot, encoding: 'utf8' });
}

export function changedProtocolFilesBetween(base, head, exec = execFileSync) {
  return git(['diff', '--no-renames', '--name-only', base, head, '--', PROTOCOL_DIR], exec)
    .split('\n')
    .filter(Boolean);
}

export function epochAtRevision(revision, exec = execFileSync) {
  return extractCompatibilityEpoch(git(['show', `${revision}:${EPOCH_FILE}`], exec));
}

/**
 * Whether a file changed only by gaining the ASF license header.
 *
 * The guard's question is whether the protocol changed. "A file under the
 * protocol directory was touched" is a conservative proxy for that, and the
 * asymmetry justifies it: a needless epoch bump costs a number, a missed one
 * ships two incompatible protocols under one. But inserting a license header
 * provably does not change the protocol, and answering that with a bump would
 * tell every peer the wire is incompatible over a comment.
 *
 * The test is `applyHeader`, the same authority that writes the headers, so
 * this exempts exactly the canonical insertion and nothing that resembles it.
 * A file that gained a header *and* a real edit fails the comparison and still
 * requires an epoch.
 *
 * Everything else is a protocol change. A file that exists on only one side —
 * added, deleted, or one half of a rename, since the diff is taken with
 * `--no-renames` — has no pair to compare and is one by definition, so the
 * failing `git show` resolves to `false` rather than escaping. Every read is
 * inside the guard for that reason: the exemption has to fail toward requiring
 * an epoch, never toward crashing the check that would have demanded one.
 */
export function isHeaderOnlyChange(file, base, head, exec = execFileSync) {
  const style = classifyPath(file).style;
  if (!style) return false;
  try {
    const before = git(['show', `${base}:${file}`], exec);
    const after = git(['show', `${head}:${file}`], exec);
    return applyHeader(before, style) === after;
  } catch {
    return false;
  }
}

function parseArgs(args) {
  const parsed = { base: undefined, head: 'HEAD' };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--base') parsed.base = args[++index];
    else if (args[index] === '--head') parsed.head = args[++index];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!parsed.base) throw new Error('Expected --base <rev> (and optionally --head <rev>)');
  return parsed;
}

function main(args) {
  const { base, head } = parseArgs(args);
  const verdict = evaluateEpochCheck({
    baseEpoch: epochAtRevision(base),
    headEpoch: epochAtRevision(head),
    changedProtocolFiles: changedProtocolFilesBetween(base, head).filter(
      (file) => !isHeaderOnlyChange(file, base, head),
    ),
  });
  process.stderr.write(`Protocol epoch guard: ${verdict.reason}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

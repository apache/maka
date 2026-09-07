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
// current base branch. An incompatible change must move the epoch. A compatible
// extension may keep it only when a declaration added against the base names every
// changed protocol file, keeping that exception explicit and reviewable. The
// `--staged` pre-commit mode judges one commit against HEAD and cannot see the base,
// so it also honors a declaration the branch amends; the merge result decides.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHeader, classifyPath } from './asf-license-headers.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

export const EPOCH_FILE = 'packages/runtime-host/src/protocol/index.ts';
export const PROTOCOL_DIR = 'packages/runtime-host/src/protocol/';
export const COMPATIBLE_CHANGE_DIR = 'packages/runtime-host/protocol-compatible-changes/';

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

const DECLARATION_KEYS = ['epoch', 'files', 'reason'];

export function parseDeclaration(declarationPath, source, headEpoch) {
  const fail = (detail) => {
    throw new Error(`Invalid compatible protocol change declaration ${declarationPath}: ${detail}`);
  };
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(`it is not valid JSON (${error.message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected a JSON object');
  const unknown = Object.keys(value).filter((key) => !DECLARATION_KEYS.includes(key));
  if (unknown.length > 0) {
    fail(
      `unknown key(s) ${unknown.join(', ')}; a declaration holds only ${DECLARATION_KEYS.join(', ')}`,
    );
  }
  if (value.epoch !== headEpoch) {
    fail(
      `it declares epoch ${JSON.stringify(value.epoch)} but this branch is at ${headEpoch}. ` +
        `Another change moved the epoch, so re-pin this declaration to ${headEpoch} and re-read ` +
        `its reason: it has to still hold against the protocol as it now stands.`,
    );
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    fail('"files" must name at least one changed protocol file');
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    fail('"reason" must say why the wire cannot observe the change');
  }
  for (const file of value.files) {
    if (typeof file !== 'string' || !file.startsWith(PROTOCOL_DIR)) {
      fail(`"files" entry ${JSON.stringify(file)} is not a path under ${PROTOCOL_DIR}`);
    }
  }
  return value.files;
}

export function evaluateEpochCheck({
  baseEpoch,
  headEpoch,
  changedProtocolFiles,
  compatibleProtocolFiles = [],
}) {
  if (headEpoch < baseEpoch) {
    return {
      ok: false,
      reason:
        `RUNTIME_HOST_COMPATIBILITY_EPOCH went backward: ${baseEpoch} -> ${headEpoch}. ` +
        `The epoch never decreases — a peer that saw ${baseEpoch} would admit an ` +
        `incompatible protocol. Bump it forward instead, even for a revert.`,
    };
  }
  const compatible = new Set(compatibleProtocolFiles);
  const incompatibleChanges = changedProtocolFiles.filter((file) => !compatible.has(file));
  if (incompatibleChanges.length > 0 && headEpoch === baseEpoch) {
    const template = JSON.stringify(
      {
        epoch: headEpoch,
        files: incompatibleChanges,
        reason: '<why the wire cannot observe this change>',
      },
      null,
      2,
    );
    return {
      ok: false,
      reason:
        `Protocol files changed but RUNTIME_HOST_COMPATIBILITY_EPOCH is still ${baseEpoch}, ` +
        `the current base parent's value. Same-number bumps on sibling branches merge without ` +
        `a git conflict (#3313), so every protocol change must land with an epoch the current ` +
        `base has not seen: rebase onto current main and set the epoch past ${baseEpoch}. ` +
        `Changed files without a compatible-change declaration:\n` +
        `${incompatibleChanges.map((file) => `  ${file}`).join('\n')}\n\n` +
        `If the wire provably cannot observe this change, declare it instead of bumping: ` +
        `add one ${COMPATIBLE_CHANGE_DIR}<slug>.json, described by the README in that ` +
        `directory, holding\n${template}`,
    };
  }
  return {
    ok: true,
    reason:
      changedProtocolFiles.length > 0
        ? headEpoch === baseEpoch
          ? `Protocol added a declared compatible extension at epoch ${headEpoch}.`
          : `Protocol changed and the epoch moved: ${baseEpoch} -> ${headEpoch}.`
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

export function compatibleProtocolFilesBetween(base, head, headEpoch, exec = execFileSync) {
  const declarations = git(
    ['diff', '--diff-filter=A', '--name-only', base, head, '--', COMPATIBLE_CHANGE_DIR],
    exec,
  )
    .split('\n')
    .filter((file) => file.endsWith('.json'));
  const compatibleFiles = new Set();
  for (const declaration of declarations) {
    const files = parseDeclaration(
      declaration,
      git(['show', `${head}:${declaration}`], exec),
      headEpoch,
    );
    for (const file of files) compatibleFiles.add(file);
  }
  return [...compatibleFiles];
}

export function epochAtRevision(revision, exec = execFileSync) {
  return extractCompatibilityEpoch(git(['show', `${revision}:${EPOCH_FILE}`], exec));
}

function stagedFile(file, exec = execFileSync) {
  return git(['show', `:${file}`], exec);
}

export function evaluateStagedEpochCheck(exec = execFileSync) {
  const changedProtocolFiles = git(
    ['diff', '--cached', '--no-renames', '--name-only', 'HEAD', '--', PROTOCOL_DIR],
    exec,
  )
    .split('\n')
    .filter(Boolean)
    .filter((file) => !isStagedHeaderOnlyChange(file, exec));
  // `M` too: a branch amends the declaration it added. The merge-result check counts
  // only declarations added against the base, so editing a landed one grants nothing.
  const declarations = git(
    ['diff', '--cached', '--diff-filter=AM', '--name-only', 'HEAD', '--', COMPATIBLE_CHANGE_DIR],
    exec,
  )
    .split('\n')
    .filter((file) => file.endsWith('.json'));
  const compatibleProtocolFiles = [];
  const headEpoch = extractCompatibilityEpoch(stagedFile(EPOCH_FILE, exec));
  for (const declaration of declarations) {
    compatibleProtocolFiles.push(
      ...parseDeclaration(declaration, stagedFile(declaration, exec), headEpoch),
    );
  }
  return evaluateEpochCheck({
    baseEpoch: epochAtRevision('HEAD', exec),
    headEpoch,
    changedProtocolFiles,
    compatibleProtocolFiles,
  });
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

export function isStagedHeaderOnlyChange(file, exec = execFileSync) {
  const style = classifyPath(file).style;
  if (!style) return false;
  try {
    const before = git(['show', `HEAD:${file}`], exec);
    const after = stagedFile(file, exec);
    return applyHeader(before, style) === after;
  } catch {
    return false;
  }
}

function parseArgs(args) {
  const parsed = { base: undefined, head: 'HEAD', staged: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--base') parsed.base = args[++index];
    else if (args[index] === '--head') parsed.head = args[++index];
    else if (args[index] === '--staged') parsed.staged = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (parsed.staged) return parsed;
  if (!parsed.base) throw new Error('Expected --base <rev> (and optionally --head <rev>)');
  return parsed;
}

function main(args) {
  const { base, head, staged } = parseArgs(args);
  if (staged) {
    const verdict = evaluateStagedEpochCheck();
    process.stderr.write(`Protocol epoch guard: ${verdict.reason}\n`);
    if (!verdict.ok) process.exitCode = 1;
    return;
  }
  const headEpoch = epochAtRevision(head);
  const verdict = evaluateEpochCheck({
    baseEpoch: epochAtRevision(base),
    headEpoch,
    changedProtocolFiles: changedProtocolFilesBetween(base, head).filter(
      (file) => !isHeaderOnlyChange(file, base, head),
    ),
    compatibleProtocolFiles: compatibleProtocolFilesBetween(base, head, headEpoch),
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

#!/usr/bin/env node

// Merge-base guard for the Runtime Host compatibility epoch (#3313).
//
// Two branches that each bump the epoch write the same text to the same line,
// so git's three-way merge resolves them without a conflict and two
// incompatible protocols end up advertising one epoch. This check runs on the
// PR merge result and fails when anything under the protocol directory changed
// while the epoch still equals the merge base's — which is exactly the state a
// silent same-number merge produces.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        `the merge base's value. Same-number bumps on sibling branches merge without a git ` +
        `conflict (#3313), so every protocol change must land with an epoch the merge base ` +
        `has not seen: rebase onto current main and set the epoch past ${baseEpoch}. ` +
        `Changed files:\n${changedProtocolFiles.map((file) => `  ${file}`).join('\n')}`,
    };
  }
  return {
    ok: true,
    reason:
      changedProtocolFiles.length > 0
        ? `Protocol changed and the epoch moved: ${baseEpoch} -> ${headEpoch}.`
        : `No protocol changes against the merge base (epoch ${headEpoch}).`,
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
    changedProtocolFiles: changedProtocolFilesBetween(base, head),
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

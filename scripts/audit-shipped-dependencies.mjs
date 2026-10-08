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

// Audits what the product artifacts ship, not what npm labels production.
//
// The renderer roots live in `devDependencies` (so electron-builder keeps
// their unread sources out of `app.asar`) while vite still bundles them into
// `dist-renderer`. An `npm audit --omit=dev` would therefore miss shipped
// vulnerabilities such as one in react. This is the product audit authority:
// one full npm report, filtered to anything that lands in the shipped CLI or
// Desktop closure — Node production plus everything reachable from the
// declared renderer roots.
//
// An advisory names a package and npm resolves it to the installed copies it
// actually reaches (`nodes`). Only a copy whose exact version is in the
// shipped closure fails here: the same name installed at a vulnerable version
// on a tooling-only path (electron → @electron/get → undici) is not shipped
// and must not turn this red. When npm elides the paths, the name alone
// fails, since the miss would otherwise be silent.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmSpawnOptions } from './npm-spawn.mjs';
import { collectWorkspaceClosure } from './third-party-closure.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
// Matches the `--audit-level=moderate` the production audit step uses.
const FAIL_RANK = SEVERITY_RANK.moderate;
const AUDIT_TIMEOUT_MS = 60_000;

function shippedCopies(vulnerability, shippedVersions, lockPackages) {
  const shipped = shippedVersions.get(vulnerability.name);
  if (!shipped) return [];
  const nodes = vulnerability.nodes ?? [];
  if (nodes.length === 0) return [...shipped].map((version) => `${version} (paths elided)`);
  return nodes
    .map((node) => lockPackages[node]?.version)
    .filter((version) => version !== undefined && shipped.has(version));
}

function unavailableDetail(audit, report) {
  const registryDetail = [report?.error?.summary, report?.error?.detail].filter(Boolean).join(': ');
  if (registryDetail) return registryDetail;
  if (audit.error instanceof Error) return audit.error.message;
  if (typeof audit.stderr === 'string' && audit.stderr.trim()) return audit.stderr.trim();
  return `npm audit exited with status ${audit.status ?? 'unknown'}`;
}

export function evaluateShippedAudit(audit, shippedVersions, lockPackages) {
  let report;
  try {
    report = JSON.parse(audit.stdout || '{}');
  } catch {
    return { outcome: 'unavailable', detail: unavailableDetail(audit) };
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    return { outcome: 'unavailable', detail: unavailableDetail(audit, report) };
  }
  const flagged = Object.values(report.vulnerabilities)
    .filter(
      (vulnerability) =>
        (SEVERITY_RANK[vulnerability.severity] ?? SEVERITY_RANK.critical) >= FAIL_RANK,
    )
    .map((vulnerability) => ({
      vulnerability,
      copies: shippedCopies(vulnerability, shippedVersions, lockPackages),
    }))
    .filter(({ copies }) => copies.length > 0)
    .sort((left, right) => left.vulnerability.name.localeCompare(right.vulnerability.name));
  return { outcome: flagged.length > 0 ? 'blocked' : 'clean', flagged };
}

function collectShippedVersions() {
  const closures = [
    collectWorkspaceClosure({ workspaceName: 'maka-agent' }),
    collectWorkspaceClosure({
      workspaceName: '@maka/desktop',
      manifestPath: join(repoRoot, 'apps', 'desktop', 'package.json'),
    }),
  ];
  const shippedVersions = new Map();
  for (const closure of closures) {
    for (const { name, version } of closure) {
      if (!shippedVersions.has(name)) shippedVersions.set(name, new Set());
      shippedVersions.get(name).add(version);
    }
  }
  return shippedVersions;
}

function main() {
  const allowUnavailable = process.argv.includes('--allow-unavailable');
  const audit = spawnSync(
    'npm',
    ['audit', '--json'],
    npmSpawnOptions({
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: AUDIT_TIMEOUT_MS,
    }),
  );
  const shippedVersions = collectShippedVersions();
  const lockPackages =
    JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')).packages ?? {};
  const result = evaluateShippedAudit(audit, shippedVersions, lockPackages);
  if (result.outcome === 'unavailable') {
    const message = `[audit-shipped] registry audit unavailable: ${result.detail}`;
    if (allowUnavailable) {
      console.warn(`${message}; continuing without an advisory result`);
      return;
    }
    throw new Error(message);
  }

  console.log(
    `[audit-shipped] product shipped closure: ${shippedVersions.size} packages; ` +
      `advisories reaching it at moderate or above: ${result.flagged.length}`,
  );
  for (const { vulnerability, copies } of result.flagged) {
    const causes = (vulnerability.via ?? [])
      .map((via) => (typeof via === 'string' ? `via ${via}` : `${via.title} (${via.url})`))
      .join('; ');
    console.error(
      `[audit-shipped] ${vulnerability.name}@${copies.join(', ')}: ${vulnerability.severity} — ${causes}`,
    );
  }
  if (result.outcome === 'blocked') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

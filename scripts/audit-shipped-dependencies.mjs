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

// Audits what the desktop artifact ships, not what npm labels production.
//
// `npm audit --omit=dev` covers the Node production closure, but the renderer
// roots live in `devDependencies` (so electron-builder keeps their unread
// sources out of `app.asar`) while vite still bundles them into
// `dist-renderer`. A vulnerability in react would therefore ship without the
// production audit ever seeing it. This audits the full npm report and fails
// on anything that lands in the shipped desktop closure — Node production
// plus everything reachable from the declared renderer roots.
//
// An advisory names a package and npm resolves it to the installed copies it
// actually reaches (`nodes`). Only a copy whose exact version is in the
// shipped closure fails here: the same name installed at a vulnerable version
// on a tooling-only path (electron → @electron/get → undici) is not shipped
// and must not turn this red. When npm elides the paths, the name alone
// fails, since the miss would otherwise be silent.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { npmSpawnOptions } from './npm-spawn.mjs';
import { collectWorkspaceClosure } from './third-party-closure.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
// Matches the `--audit-level=moderate` the production audit step uses.
const FAIL_RANK = SEVERITY_RANK.moderate;

function npmAuditReport() {
  const options = npmSpawnOptions({
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--json'], options));
  } catch (error) {
    // npm audit exits nonzero when it finds anything; the JSON is complete.
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

const closure = collectWorkspaceClosure({
  workspaceName: '@maka/desktop',
  manifestPath: join(repoRoot, 'apps', 'desktop', 'package.json'),
});
const shippedVersions = new Map();
for (const { name, version } of closure) {
  if (!shippedVersions.has(name)) shippedVersions.set(name, new Set());
  shippedVersions.get(name).add(version);
}

const lockPackages =
  JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')).packages ?? {};

function shippedCopies(vulnerability) {
  const shipped = shippedVersions.get(vulnerability.name);
  if (!shipped) return [];
  const nodes = vulnerability.nodes ?? [];
  if (nodes.length === 0) return [...shipped].map((version) => `${version} (paths elided)`);
  return nodes
    .map((node) => lockPackages[node]?.version)
    .filter((version) => version !== undefined && shipped.has(version));
}

const report = npmAuditReport();
const flagged = Object.values(report.vulnerabilities ?? {})
  .filter(
    (vulnerability) =>
      (SEVERITY_RANK[vulnerability.severity] ?? SEVERITY_RANK.critical) >= FAIL_RANK,
  )
  .map((vulnerability) => ({ vulnerability, copies: shippedCopies(vulnerability) }))
  .filter(({ copies }) => copies.length > 0)
  .sort((left, right) => left.vulnerability.name.localeCompare(right.vulnerability.name));

console.log(
  `[audit-shipped] desktop shipped closure: ${shippedVersions.size} packages; ` +
    `advisories reaching it at moderate or above: ${flagged.length}`,
);
for (const { vulnerability, copies } of flagged) {
  const causes = (vulnerability.via ?? [])
    .map((via) => (typeof via === 'string' ? `via ${via}` : `${via.title} (${via.url})`))
    .join('; ');
  console.error(
    `[audit-shipped] ${vulnerability.name}@${copies.join(', ')}: ${vulnerability.severity} — ${causes}`,
  );
}
if (flagged.length > 0) process.exit(1);

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

import { dirname, relative, resolve } from 'node:path';
import { suites, workers } from './suites.mjs';

export function contains(directory, path) {
  return path === directory || path.startsWith(`${directory}/`);
}

const shared = [
  '.cargo',
  '.config',
  '.github/workflows',
  '.github/actions',
  'package.json',
  'package-lock.json',
  'justfile',
  'biome.jsonc',
  'scripts/ci.mjs',
  'scripts/ci',
];

export function sharedInput(path) {
  return /(^|\/)Cargo\.(toml|lock)$/.test(path) || shared.some((entry) => contains(entry, path));
}

export function documentation(path) {
  return (
    contains('docs', path) ||
    contains('website', path) ||
    (/\.md$/.test(path) &&
      !['skills', 'platform/computer-use/skills'].some((entry) => contains(entry, path)))
  );
}

function graph(root, metadata) {
  const packages = new Map();
  const reverse = new Map();
  const members = new Map();
  for (const [workspace, data] of Object.entries(metadata)) {
    const identities = new Map(
      data.packages.map((pkg) => [pkg.id, pkg.source ? pkg.id : resolve(pkg.manifest_path)]),
    );
    members.set(workspace, new Set(data.workspace_members.map((id) => identities.get(id))));
    for (const pkg of data.packages) {
      const path = relative(root, dirname(pkg.manifest_path)).split('\\').join('/');
      if (!pkg.source && path !== '..' && !path.startsWith('../')) {
        packages.set(identities.get(pkg.id), { name: pkg.name, path });
      }
    }
    for (const node of data.resolve.nodes) {
      const consumer = identities.get(node.id);
      for (const dependency of node.deps) {
        const key = identities.get(dependency.pkg);
        if (!reverse.has(key)) reverse.set(key, new Set());
        reverse.get(key).add(consumer);
      }
    }
  }
  return { packages, reverse, members };
}

function expanded(seeds, reverse) {
  const reached = new Set(seeds);
  for (const key of reached) {
    for (const consumer of reverse.get(key) ?? []) reached.add(consumer);
  }
  return reached;
}

function suitePackage(suite, key, packages, members) {
  const pkg = packages.get(key);
  if (!pkg || !suite.workspace) return false;
  return suite.packages === 'workspace'
    ? members.get(suite.workspace).has(key)
    : suite.packages.includes(pkg.name);
}

export function createPlan({ root, changes = null, metadata = {}, revision, baseline = null }) {
  const selected = {};
  const fullReasons =
    changes === null ? ['full validation requested'] : changes.filter(sharedInput);
  let full = fullReasons.length > 0;
  const inputs = changes?.filter((path) => !documentation(path)) ?? [];
  if (!full && inputs.length) {
    const { packages, reverse, members } = graph(root, metadata);
    const ownership = [...packages].sort((a, b) => b[1].path.length - a[1].path.length);
    const owners = new Map(
      inputs.map((path) => [path, ownership.find(([, pkg]) => contains(pkg.path, path))?.[0]]),
    );
    const extraInput = (suite, path) =>
      !(owners.get(path) && path.endsWith('.rs')) &&
      suite.extraInputs?.some((entry) => contains(entry, path));
    const supported = new Set(
      [...packages.keys()].filter((key) =>
        Object.values(suites).some((suite) => suitePackage(suite, key, packages, members)),
      ),
    );
    const seeds = new Set();
    for (const path of inputs) {
      const owner = owners.get(path);
      if (owner) seeds.add(owner);
      const extra = Object.values(suites).some((suite) => extraInput(suite, path));
      if (!owner && !extra) fullReasons.push(`unmapped input: ${path}`);
      if (owner && !extra && ![...expanded([owner], reverse)].some((key) => supported.has(key)))
        fullReasons.push(`outside maintained suites: ${path}`);
    }
    full = fullReasons.length > 0;
    if (!full) {
      const reached = expanded(seeds, reverse);
      for (const [id, suite] of Object.entries(suites)) {
        const extras = inputs.filter((path) => extraInput(suite, path));
        const affected = [...reached]
          .filter((key) => suitePackage(suite, key, packages, members))
          .map((key) => packages.get(key).name)
          .sort();
        if (suite.always || extras.length || affected.length) {
          selected[id] = {
            filter:
              suite.affectedFilter && !extras.length
                ? affected.map((name) => `package(=${name})`).join(' | ')
                : (suite.filter ?? 'all()'),
            reason: suite.always
              ? 'always checked'
              : extras.length
                ? `runtime inputs: ${extras.join(', ')}`
                : `affected packages: ${affected.join(', ')}`,
          };
        }
      }
    }
  }
  if (full) {
    for (const [id, suite] of Object.entries(suites))
      selected[id] = { filter: suite.filter ?? 'all()', reason: fullReasons.join(', ') };
  } else if (inputs.length) {
    selected.tooling = { filter: 'all()', reason: 'always checked' };
  }
  const matrix = workers.flatMap((worker) => {
    const entries = worker.suites.filter((id) => selected[id]);
    return entries.length ? [{ ...worker, suites: entries }] : [];
  });
  return { revision, baseline, full, reasons: fullReasons, suites: selected, workers: matrix };
}

export function checkResults(plan, results, hasRootTests) {
  const required = ['plan'];
  if (plan.suites.tooling) required.push('tooling');
  if (plan.workers.length) required.push('suites');
  if (plan.suites.root) {
    if (typeof hasRootTests !== 'boolean')
      throw new Error('Root producer did not report whether tests were selected');
    if (!hasRootTests && plan.suites.root.filter === 'all()')
      throw new Error('The full root test selection was unexpectedly empty');
    required.push('root-build');
    if (hasRootTests) required.push('root-tests');
  }
  const failures = required.filter((id) => results[id]?.result !== 'success');
  if (failures.length) throw new Error(`Required CI jobs did not succeed: ${failures.join(', ')}`);
}

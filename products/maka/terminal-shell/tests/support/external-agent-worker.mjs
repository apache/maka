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

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const stateFile = process.argv[2];
const traceFile = process.argv[3];
appendFileSync(traceFile, `${JSON.stringify({ kind: 'started' })}\n`);
const input = createInterface({ input: process.stdin });
const request = JSON.parse((await input[Symbol.asyncIterator]().next()).value);
appendFileSync(traceFile, `${JSON.stringify(request)}\n`);
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const statuses = [
  {
    id: 'claude',
    name: 'Claude Code',
    installation: { kind: 'available' },
    authentication: { kind: 'authenticated', source: 'native Claude account' },
    models: {
      kind: 'error',
      detail: 'Claude listModels failed: fixture-vendor-error',
    },
    canInstall: true,
    installLines: [],
  },
  {
    id: 'codex',
    name: 'Codex',
    installation: { kind: 'available', version: '1.0' },
    authentication: { kind: 'authenticated', source: 'codex login status' },
    models: { kind: 'ready', count: 1 },
    canInstall: true,
    installLines: [],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    installation: state.antigravityMissing
      ? { kind: 'not_found' }
      : { kind: 'available', version: 'fixture-agy-installed' },
    authentication: {
      kind: state.signedIn ? 'authenticated' : 'unauthenticated',
      source: 'native login status',
    },
    models: state.signedIn
      ? { kind: 'ready', count: 1 }
      : { kind: 'unauthenticated', detail: 'Native login required' },
    canInstall: true,
    installLines: [],
  },
  {
    id: 'grok',
    name: 'Grok Build',
    installation: { kind: 'available' },
    authentication: {
      kind: 'unknown',
      detail: 'Vendor cannot determine account status',
    },
    models: { kind: 'unavailable' },
    canInstall: false,
    installLines: [],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    installation: state.installed
      ? { kind: 'available', version: 'fixture-installed' }
      : { kind: 'not_found' },
    authentication: { kind: 'unknown', detail: 'Qwen account not checked' },
    models: { kind: 'unavailable' },
    canInstall: true,
    installLines: [{ line: 'stable', description: 'Stable release' }],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    installation: { kind: 'not_found' },
    authentication: { kind: 'unknown' },
    models: { kind: 'unavailable' },
    canInstall: true,
    installLines: [],
  },
];
let selected = [];
if (request.kind === 'status' || request.kind === 'catalog') {
  const ids = request.runtime === undefined ? request.runtimes : [request.runtime];
  if (!Array.isArray(ids) || ids.length === 0)
    throw new Error('The Host must supply a nonempty explicit runtime selection');
  selected = ids.map((id) => {
    const runtime = statuses.find((runtime) => runtime.id === id);
    if (!runtime) throw new Error(`Unexpected selected runtime ${id}`);
    for (const phase of request.kind === 'status'
      ? ['installation', 'authentication', 'models']
      : ['installation', 'models']) {
      appendFileSync(
        traceFile,
        `${JSON.stringify({ kind: 'runtime_call', runtime: id, phase })}\n`,
      );
    }
    return runtime;
  });
}
let value;
if (request.kind === 'status') value = selected;
else if (request.kind === 'catalog') {
  const catalog = selected.map((runtime) => ({
    runtime: runtime.id,
    installation: runtime.installation,
    models:
      runtime.models.kind === 'ready'
        ? {
            kind: 'ok',
            models: [
              {
                id: 'external-model',
                displayName: 'External model',
                effortLevels: ['vendor-fast', 'vendor-deep'],
                defaultEffort: 'vendor-fast',
              },
            ],
          }
        : runtime.models,
  }));
  value =
    request.runtime === undefined
      ? catalog
      : catalog.find((runtime) => runtime.runtime === request.runtime);
} else if (request.kind === 'setup') {
  if (request.runtime === 'qoder')
    value = {
      kind: 'unsupported',
      detail: 'Fixture platform has no Qoder installer',
    };
  else if (request.runtime === 'antigravity') {
    if (request.action === 'plan')
      value = {
        kind: 'plan',
        runtime: 'antigravity',
        source: 'https://antigravity.google/docs/getting-started/?tab=cli',
        network: true,
        privileges: false,
        steps: [
          {
            display: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
          },
        ],
      };
    else if (request.action === 'install') {
      state.antigravityMissing = false;
      state.installCount += 1;
      writeFileSync(stateFile, JSON.stringify(state));
      value = { kind: 'installed' };
    } else throw new Error(`Unexpected Antigravity setup action ${request.action}`);
  } else if (request.runtime !== 'qwen')
    throw new Error(`Unexpected setup runtime ${request.runtime}`);
  else if (request.action === 'plan')
    value = {
      kind: 'plan',
      runtime: 'qwen',
      line: 'stable',
      source: 'https://vendor.invalid/qwen',
      network: true,
      privileges: false,
      steps: [{ display: 'npm install --global fixture-qwen' }],
    };
  else if (request.action === 'install') {
    state.installed = true;
    state.installCount += 1;
    writeFileSync(stateFile, JSON.stringify(state));
    value = state.unknownResult ? { kind: 'fixture_unknown' } : { kind: 'installed' };
  } else throw new Error(`Unexpected setup action ${request.action}`);
} else throw new Error(`Unexpected worker request ${request.kind}`);
process.stdout.write(`${JSON.stringify({ sequence: 1, kind: request.kind, value })}\n`);
input.close();
process.stdin.destroy();

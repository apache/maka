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

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageDigest } from '../../../../scripts/plugins/product-version.mjs';
import {
  composition,
  installation,
  installationNames,
  packageNames,
} from '../dist/authoring/composition.mjs';
import { contracts, nativeImplementations } from '../dist/authoring/sdk.mjs';

async function packageFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...(await packageFiles(path, name + '/')));
    else {
      assert.ok(entry.isFile(), `Built package contains a non-regular file: ${path}`);
      files.push([name, await readFile(path)]);
    }
  }
  return files;
}

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const names = JSON.parse(await readFile(join(dist, 'packages.json'), 'utf8'));
const built = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => {
      const files = new Map(await packageFiles(join(dist, 'packages', name)));
      const manifest = JSON.parse(files.get('maka.extension.json').toString('utf8'));
      return [
        name,
        {
          manifest,
          ref: { id: manifest.id, revision: packageDigest(files) },
        },
      ];
    }),
  ),
);

// Installation inputs describe a composition only; no helper or Host is started.
const defaults = installation({
  workspace: fileURLToPath(new URL('./', import.meta.url)),
  helper: 'declaration-only-workspace-helper',
});
const keys = Object.fromEntries(installationNames(defaults).map((name) => [name, randomUUID()]));
const source = composition({
  ...defaults,
  packages: Object.fromEntries(names.map((name) => [name, built[name].ref])),
  keys,
  hostDeployment: randomUUID(),
});
const { instances } = source.host;

test('built installation binds continuation, Goal and Scheduler to the original Agent export', () => {
  assert.deepEqual(new Set(names), new Set(packageNames));
  const target = [{ kind: 'instance', path: ['agent'], export: 'agent' }];
  assert.deepEqual(instances.gateway.bindings.agent, target);
  assert.deepEqual(instances['conversations-ui'].bindings.agent, target);
  assert.deepEqual(instances.agent.package, { source: 'pinned', package: built.agent.ref });
  assert.equal(instances.agent.usePackage, 'host');
  assert.deepEqual(instances['conversations-ui'].package, {
    source: 'pinned',
    package: built.conversations.ref,
  });
  assert.equal(instances['conversations-ui'].usePackage, 'ui');

  const provider = built.agent.manifest.application.host;
  assert.deepEqual(provider.implementation, {
    kind: 'native',
    implementation: nativeImplementations.agent.implementation,
  });
  assert.equal(provider.exports.agent.availability, 'required');
  const consumer = built.conversations.manifest.application.ui.imports.agent;
  assert.deepEqual(consumer.cardinality, { kind: 'one' });
  const agent = instances.agent.configuration.values;
  assert.equal(agent.goals, true);
  assert.equal(agent.scheduledTasks, true);
  const tools = agent.tools.filter((tool) => tool.name === 'SessionContinueRun');
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].target, { kind: 'export', name: target[0].export });
  assert.equal(tools[0].method, 'continueRun');

  assert.deepEqual(source.endpoints.agent.consumer, [keys.gateway]);
  assert.equal(source.endpoints.agent.import, 'agent');
  assert.equal(source.endpoints.agent.grant.recovery, true);
  const methods = [
    ['continuationAvailability', 'query'],
    ['continueRun', 'mutation'],
    ['goal', 'query'],
    ['changeGoal', 'mutation'],
    ['watchGoal', 'subscription'],
    ['schedule', 'mutation'],
    ['schedules', 'query'],
    ['watchSchedules', 'subscription'],
    ['scheduleAlerts', 'subscription'],
  ];
  for (const contract of [provider.exports.agent.contract, consumer.contract]) {
    for (const field of ['name', 'version', 'transport'])
      assert.equal(contract[field], contracts.agent[field], field);
    assert.equal(contract.interface.kind, 'service');
    for (const [method, mode] of methods) {
      assert.equal(contract.interface.methods[method]?.mode, mode, method);
      assert.deepEqual(
        contract.interface.methods[method],
        contracts.agent.interface.methods[method],
        `Built Agent contract mismatch: ${method}`,
      );
      assert.ok(source.endpoints.agent.grant.methods.includes(method), method);
    }
  }

  const continuation = provider.exports.agent.contract.interface.methods.continueRun.input;
  assert.deepEqual(
    new Set(continuation.required),
    new Set(['sessionId', 'sourceRunId', 'sourceHighWater', 'model']),
  );
  assert.equal(continuation.additionalProperties, false);
  assert.equal(continuation.properties.sourceHighWater.minimum, 1);
});

test('built recovery gateway binds the exact ReceiptReader query without caller override input', () => {
  const gateway = instances['recovery-gateway'];
  assert.deepEqual(gateway.package, { source: 'pinned', package: built['recovery-gateway'].ref });
  assert.equal(gateway.usePackage, 'host');
  const declaration = built['recovery-gateway'].manifest.application.host;
  assert.deepEqual(declaration.implementation, {
    kind: 'native',
    implementation: nativeImplementations.gateway.implementation,
  });
  const target = [{ kind: 'instance', path: ['receipts'], export: 'Receipts' }];
  assert.deepEqual(gateway.bindings.receipts, target);
  assert.deepEqual(instances['conversations-ui'].bindings.receipts, target);
  assert.deepEqual(instances.receipts.package, { source: 'pinned', package: built.receipts.ref });
  assert.equal(instances.receipts.usePackage, 'host');
  const provider = built.receipts.manifest.application.host.exports.Receipts;
  assert.equal(provider.availability, 'required');
  assert.deepEqual(declaration.imports.receipts.cardinality, { kind: 'one' });
  assert.deepEqual(declaration.imports.receipts.contract, provider.contract);
  assert.deepEqual(provider.contract, contracts.receiptReader);
  assert.deepEqual(
    built.conversations.manifest.application.ui.imports.receipts.contract,
    provider.contract,
  );
  assert.deepEqual(source.endpoints.receipts, {
    consumer: [keys['recovery-gateway']],
    import: 'receipts',
    grant: { methods: ['read'], recovery: true },
  });

  const read = provider.contract.interface.methods.read;
  assert.equal(read.mode, 'query');
  assert.deepEqual(read.resources, {});
  const fields = new Set([
    'source',
    'namespace',
    'export',
    'method',
    'operation',
    'fingerprint',
    'contract',
    'recovery',
  ]);
  assert.deepEqual(new Set(read.input.required), fields);
  assert.deepEqual(new Set(Object.keys(read.input.properties)), fields);
  assert.equal(read.input.additionalProperties, false);
  assert.deepEqual(
    new Set(read.input.$defs.RecoveryContract.required),
    new Set(['name', 'version', 'transport', 'digest']),
  );
  assert.deepEqual(read.input.$defs.RecoveryProtocol.enum, ['journal_v1']);
});

test('the built default installation nests service tools except computer REPL and user questions', () => {
  const tools = instances.agent.configuration.values.tools;
  const directOnly = tools.filter((tool) => !tool.nestable).map((tool) => tool.name);
  assert.deepEqual(directOnly, ['cua_repl', 'cua_reset', 'AskUserQuestion']);
  const nested = new Set(tools.filter((tool) => tool.nestable).map((tool) => tool.name));
  for (const expected of [
    'Read',
    'Shell',
    'WebFetch',
    'Skill',
    'PluginReadDeployment',
    'PluginEditComposition',
    'ModelList',
    'SessionCreate',
    'SessionSend',
    'SessionWork',
  ]) {
    assert.ok(nested.has(expected), `expected ${expected} to be nestable`);
  }
});

test('preset tools bind shared Agent methods and recoverable product grants', () => {
  const tools = instances.agent.configuration.values.tools;
  for (const [name, method] of [
    ['SubagentPresetList', 'presets'],
    ['SubagentPresetRead', 'preset'],
    ['SubagentPresetCreate', 'createPreset'],
    ['SubagentPresetUpdate', 'updatePreset'],
    ['SubagentPresetDelete', 'deletePreset'],
  ]) {
    const selected = tools.filter((tool) => tool.name === name);
    assert.equal(selected.length, 1);
    assert.deepEqual(selected[0].target, { kind: 'export', name: 'agent' });
    assert.equal(selected[0].method, method);
    assert.equal(selected[0].nestable, true);
    assert.ok(source.endpoints.agent.grant.methods.includes(method));
    assert.deepEqual(
      built.agent.manifest.application.host.exports.agent.contract.interface.methods[method],
      contracts.agent.interface.methods[method],
    );
  }
  assert.equal(source.endpoints.agent.grant.recovery, true);
});

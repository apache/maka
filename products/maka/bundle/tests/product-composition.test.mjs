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
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the product ships complete Host and shared UI packages', () => {
  const inputs = JSON.parse(readFileSync(resolve(root, 'package-inputs.json'), 'utf8'));
  const names = readdirSync(resolve(root, 'dist/packages')).sort();
  assert.deepEqual(names, Object.keys(inputs).sort());
  for (const name of names) {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'dist/packages', name, 'maka.extension.json'), 'utf8'),
    );
    assert.ok(
      manifest.application.host || manifest.application.ui || manifest.application.composition,
      name,
    );
    if (manifest.application.ui)
      assert.ok(
        existsSync(resolve(root, 'dist/packages', name, manifest.application.ui.module)),
        name,
      );
    assert.ok(manifest.displayName?.trim(), name);
    assert.ok(manifest.description?.trim(), name);
    assert.ok(manifest.localizations?.['zh-CN']?.description?.trim(), name);
  }
});

test('WorkHub product binds independent agents and direct UI management in the actual CLI', async () => {
  const binary = process.env.MAKA_UI_BUNDLER;
  assert.ok(binary, 'Run npm --workspace @maka-agent/product test to build the current CLI');
  const directory = mkdtempSync(resolve(tmpdir(), 'maka-workhub-composition-'));
  try {
    const agent = {
      workspaceRoots: [{ label: 'Project', path: '/private/product-workspace' }],
      permissions: { access: 'workspace_write', requestPermissions: true },
      tools: [
        {
          name: 'ReadPlugins',
          description: 'Read enabled UI plugins',
          import: 'ui',
          method: 'readUi',
          result: 'json',
          confirmation: 'preapproved',
        },
      ],
    };
    {
      const configuration = {
        locale: 'en',
        agent,
        coordinator: {
          ...agent,
          tools: [
            {
              name: 'Execute',
              description: 'Run a command',
              import: 'processes',
              method: 'execute',
              result: 'json',
              confirmation: 'preapproved',
            },
          ],
        },
        coordinatorProcesses: {
          filesystem: { default: 'read', rules: [], denyGlobs: [] },
          network: 'denied',
          helper: null,
        },
      };
      const path = resolve(directory, 'configuration.json');
      writeFileSync(path, JSON.stringify(configuration));
      const output = resolve(directory, 'host-source');
      execFileSync(
        binary,
        ['application', 'compose', '--configuration', path, '--output', output],
        { encoding: 'utf8', env: { ...process.env, PATH: directory, NODE_PATH: '' } },
      );
      const read = (name) => JSON.parse(readFileSync(resolve(output, `${name}.json`), 'utf8'));
      const { keys, hostDeployment } = read('installation');
      const host = read('host');
      assert.match(hostDeployment, /^[0-9a-f-]{36}$/);
      assert.deepEqual(host.ui, { path: ['workbench-ui'], id: 'root' });
      const ui = host.instances['workbench-ui'];
      assert.equal(ui.key, keys['workbench-ui']);
      assert.deepEqual(ui.package, { source: 'pinned', package: read('packages').workbench });
      assert.equal(ui.usePackage, 'ui');
      assert.deepEqual(ui.bindings, {});
      assert.deepEqual(ui.configuration.values.session, {
        path: ['conversations-ui'],
        id: 'session',
      });
      const conversationUi = host.instances['conversations-ui'];
      assert.deepEqual(conversationUi.configuration.values.composer, {
        path: ['composer-ui'],
        id: 'composer',
      });
      assert.deepEqual(conversationUi.bindings.agent, [
        { kind: 'instance', path: ['agent'], export: 'agent' },
      ]);
      assert.deepEqual(conversationUi.bindings.coordinator, [
        { kind: 'instance', path: ['workhub'], export: 'agent' },
      ]);
      assert.deepEqual(conversationUi.bindings.coordinatorTerminal, [
        {
          kind: 'instance',
          path: ['coordinator-workspace-processes'],
          export: 'terminal',
        },
      ]);
      const workbench = JSON.parse(
        readFileSync(resolve(root, 'dist/packages/workbench/maka.extension.json'), 'utf8'),
      );
      assert.deepEqual(workbench.application.ui.contributions.root, { kind: 'root' });
      assert.equal(existsSync(resolve(output, 'ui.json')), false);
      assert.equal(existsSync(resolve(output, 'management-host.json')), false);
      assert.deepEqual(host.instances.workhub.bindings.worker, [
        { kind: 'instance', path: ['agent'], export: 'agent' },
      ]);
      assert.deepEqual(
        host.instances['coordinator-workspace-processes'].configuration.values.sessionOwner,
        [keys.workhub],
      );
      assert.equal(
        host.instances['coordinator-workspace-processes'].configuration.values.sessionKind,
        'workhub',
      );
      assert.equal(host.instances['workspace-processes'], undefined);
      const endpoints = read('endpoints');
      assert.deepEqual(endpoints.coordinator.consumer, [keys.gateway]);
      assert.equal(endpoints.coordinator.import, 'coordinator');
      assert.deepEqual(endpoints.workhub.consumer, [keys.gateway]);
      assert.equal(endpoints.workhub.import, 'workhub');
      const grants = read('native-grants');
      assert.ok(
        grants.some(
          (grant) =>
            grant.origin[0] === keys.workhub &&
            grant.provider[0] === keys.agent &&
            grant.methods.includes('send'),
        ),
      );
      assert.ok(
        grants.some(
          (grant) =>
            grant.origin[0] === keys.workhub &&
            grant.provider[0] === keys['coordinator-workspace-processes'] &&
            grant.methods.includes('execute'),
        ),
      );
      assert.deepEqual(host.instances.agent.bindings.ui, [
        {
          kind: 'instance',
          path: ['host-deployment-manager'],
          export: 'Management',
        },
      ]);
      assert.deepEqual(
        grants.filter((grant) => grant.origin[0] === keys.agent),
        [
          {
            origin: [keys.agent],
            consumer: [keys.agent],
            provider: [keys['host-deployment-manager']],
            export: 'Management',
            methods: ['readUi'],
            recovery: true,
          },
        ],
      );
      const installation = read('installation');
      writeFileSync(path, JSON.stringify(installation));
      const repeated = resolve(directory, 'same-installation');
      execFileSync(
        binary,
        ['application', 'compose', '--configuration', path, '--output', repeated],
        { encoding: 'utf8', env: { ...process.env, PATH: directory, NODE_PATH: '' } },
      );
      for (const name of ['host', 'endpoints', 'native-grants', 'installation'])
        assert.deepEqual(
          JSON.parse(readFileSync(resolve(repeated, `${name}.json`), 'utf8')),
          read(name),
          `${name} identities and authority survive reauthoring`,
        );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native Web tools freeze their display contract while retaining explicit custom presentations', async () => {
  const { composition, instanceNames, packageNames } = await import(
    '../dist/authoring/composition.mjs'
  );
  const { host } = composition({
    locale: 'en',
    hostDeployment: 'host',
    keys: Object.fromEntries(instanceNames.map((name, index) => [name, `key-${index}`])),
    packages: Object.fromEntries(
      packageNames.map((name) => [name, { id: name, revision: 'a'.repeat(64) }]),
    ),
    web: { network: 'denied' },
    agent: {
      workspaceRoots: [],
      tools: [
        {
          name: 'WorkspacePage',
          description: 'Fetch a page',
          import: 'web',
          method: 'fetch',
          result: 'json',
          confirmation: 'preapproved',
        },
        {
          name: 'WorkspaceQuery',
          description: 'Search the web',
          import: 'web',
          method: 'search',
          result: 'json',
          confirmation: 'preapproved',
        },
        {
          name: 'CustomPage',
          description: 'Use a custom card',
          import: 'web',
          method: 'fetch',
          result: 'json',
          confirmation: 'preapproved',
          presentation: 'product.customPage@2',
        },
      ],
    },
  });
  const tools = host.instances.agent.configuration.values.tools;
  assert.deepEqual(
    tools.map(({ name, input, presentation }) => ({ name, input, presentation })),
    [
      { name: 'WorkspacePage', input: 'web', presentation: 'maka.workspace.Web@1/fetch' },
      { name: 'WorkspaceQuery', input: 'web', presentation: 'maka.workspace.Web@1/search' },
      { name: 'CustomPage', input: 'web', presentation: 'product.customPage@2' },
    ],
  );
  assert.deepEqual(host.instances.agent.bindings.web, [
    { kind: 'instance', path: ['workspace-web'], export: 'web' },
  ]);
});

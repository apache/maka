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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  browserRegistry,
  inventory,
  machineApi,
  makaSurface,
  nativeClientSurface,
  unifiedSurface,
} from './inventory.mjs';

const parserPath = process.env.MAKA_PARITY_PARSER_MODULE;
const babel = parserPath ? createRequire(import.meta.url)(parserPath) : null;
const parser = babel
  ? {
      parse: (text, typescript = false) =>
        babel.parse(text, { sourceType: 'module', plugins: typescript ? ['typescript'] : [] })
          .program,
    }
  : null;
const source = { path: 'synthetic-fixture', sha256: 'a'.repeat(64), bytes: 100 };
const member = (text = 'run(): void;') => ({ declarations: [{ text, references: [] }] });
const api = () => ({
  root: 'Root',
  interfaces: {
    Root: {
      open: {
        declarations: [{ text: 'open: Child;', references: ['Child'] }],
        unsupportedByDefaultIn: ['cdp'],
      },
      hidden: { ...member(), documented: false },
    },
    Child: { run: member() },
  },
  types: {
    Collection: {
      text: 'type Collection = { list(): Promise<Array<{ id: string }>>; };',
      references: [],
    },
  },
});

test('machine inventory retains hidden/default-disabled members and filters documentation bodies', () => {
  const result = machineApi(
    api(),
    [
      {
        name: 'fixture',
        mode: 'model',
        description: 'SECRET_DOCUMENTATION_BODY',
        when: { requiredApiMembers: ['Child.run'] },
      },
    ],
    source,
    source,
    null,
  );
  assert.equal(result.interface_count, 2);
  assert.equal(result.member_count, 3);
  assert.equal(result.members.find((m) => m.id === 'Root.hidden').documented, false);
  assert.equal(
    result.members.find((m) => m.id === 'Child.run').default_graph_reachability.cdp,
    'no-default-reference-path',
  );
  assert.equal(
    result.members.find((m) => m.id === 'Child.run').default_graph_reachability.extension,
    'declared-reference-path-exists',
  );
  assert.equal(result.types[0].members, null);
  assert.deepEqual(result.document_conditions[0].conditions, { requiredApiMembers: ['Child.run'] });
  assert.ok(!JSON.stringify(result).includes('SECRET_DOCUMENTATION_BODY'));
  assert.ok(!JSON.stringify(result).includes('run(): void;'));
});

test('unrecognized machine schema fails rather than emitting an empty complete inventory', () => {
  assert.throws(() => machineApi({ root: 'Root' }, [], source, source, null), /Unrecognized/);
  const changed = api();
  changed.interfaces.Child.run.newAvailabilityGate = 'DO_NOT_COPY_UNKNOWN_VALUES';
  const result = machineApi(
    changed,
    [{ name: 'fixture', mode: 'model', when: { newCondition: 'DO_NOT_COPY_UNKNOWN_VALUES' } }],
    source,
    source,
    null,
  );
  assert.deepEqual(
    result.unknowns.map((row) => row.kind),
    ['uninterpreted-member-metadata', 'uninterpreted-document-conditions'],
  );
  assert.ok(!JSON.stringify(result).includes('DO_NOT_COPY_UNKNOWN_VALUES'));
});

test('AST registry resolves literal aliases and preserves unknown command declarations', {
  skip: !parser && 'supply an existing Babel parser with MAKA_PARITY_PARSER_MODULE',
}, () => {
  const ast = parser.parse(`
    const first = 'fixture_read', second = 'fixture_write', cycle = () => cycle, read = {}, write = {}, dynamic = {}, cyclic = {};
    exportBindings(read, {commandType: () => first});
    exportBindings(write, {commandType: () => second});
    exportBindings(dynamic, {commandType: () => runtimeName()});
    exportBindings(cyclic, {commandType: () => cycle});
    const info = {id:'fixtureCapability', description:'SECRET_CAPABILITY_DESCRIPTION'};
    const Impl = class { send() {} [computedName]() {} };
    register({capability:Impl,info});
  `);
  const result = browserRegistry(ast, source);
  assert.deepEqual(
    result.commands.map((row) => row.command),
    ['fixture_read', 'fixture_write'],
  );
  assert.equal(result.command_type_properties, 4);
  assert.equal(result.unknowns[0].kind, 'unresolved-command-type');
  assert.equal(result.unknowns[1].kind, 'unresolved-command-type');
  assert.equal(result.unknowns[2].kind, 'computed-capability-method');
  assert.deepEqual(result.capabilities[0].callable_members, ['send']);
  assert.ok(!JSON.stringify(result).includes('SECRET_CAPABILITY_DESCRIPTION'));
});

test('type members distinguish a collection method from nested return-value fields', {
  skip: !parser && 'supply an existing Babel parser with MAKA_PARITY_PARSER_MODULE',
}, () => {
  const result = machineApi(api(), [], source, source, parser);
  assert.deepEqual(result.types[0].members, [{ name: 'list', kind: 'method' }]);
  assert.deepEqual(result.unknowns, []);
});

test('compiled async refusals remain unconditional and platform-specific', {
  skip: !parser && 'supply an existing Babel parser with MAKA_PARITY_PARSER_MODULE',
}, () => {
  const ast = parser.parse(`function make(platform) { switch(platform) {
    case 'linux': return {getAXState() {}, selectText() {return awaiter(null,null,null,function*(){throw Error('SECRET_REFUSAL_TEXT')})}};
    case 'mac': return {getAXState() {}, selectText() {return awaiter(null,null,null,function*(){if (check()) throw Error('failure'); return select()})}};
  } }`);
  const result = unifiedSurface(ast, source);
  assert.equal(
    result.targets
      .find((row) => row.platform === 'linux')
      .members.find((row) => row.name === 'selectText').syntax,
    'always-throws',
  );
  assert.equal(
    result.targets
      .find((row) => row.platform === 'mac')
      .members.find((row) => row.name === 'selectText').syntax,
    'contains-refusal-branch',
  );
  assert.ok(!JSON.stringify(result).includes('SECRET_REFUSAL_TEXT'));
});

test('Maka arrow-bound target and Tab additions are inventoried without executing the facade', {
  skip: !parser && 'supply an existing Babel parser with MAKA_PARITY_PARSER_MODULE',
}, () => {
  const ast = parser.parse(`
    const bind = async () => {
      const target = {click() {}, [runtimeName()]() {}};
      if (result.kind === 'tab') Object.assign(target, {goto() {}});
      return target;
    };
    Object.defineProperty(globalThis,'cua',{value:Object.freeze({getBrowser: async () => Object.freeze({browserId:'fixture',documentation,tabs:{list(){}}})})});
  `);
  const result = makaSurface(ast, source);
  assert.deepEqual(
    result.shapes.Tab.members.map((row) => row.name),
    ['click', 'goto'],
  );
  assert.equal(result.shapes.Tab.unknowns[0].kind, 'dynamic-object-member');
  assert.deepEqual(
    result.shapes.Tabs.members.map((row) => row.name),
    ['list'],
  );
  assert.equal(result.shapes.Agent, null);
  const helperProduced = makaSurface(
    parser.parse('const bind = () => { const target = createTarget(); return target; };'),
    source,
  );
  assert.equal(helperProduced.shapes.Tab.unknowns[0].kind, 'unresolved-bound-target-literal');
});

test('native client source preserves callable assignments and declared audio methods', {
  skip: !parser && 'supply an existing Babel parser with MAKA_PARITY_PARSER_MODULE',
}, () => {
  const ast = parser.parse(
    `class Client { constructor() {this.type_text=async()=>{};this.target='windows';} } const optional={start_audio_recording(){},stop_audio_recording(){}};`,
  );
  assert.deepEqual(
    nativeClientSurface(ast, source, 'windows').members.map((row) => row.name),
    ['type_text', 'target', 'start_audio_recording', 'stop_audio_recording'],
  );
});

test('JSON-only CLI performs no source execution and protects existing inventories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'maka-parity-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime');
  const maka = join(root, 'maka');
  const docs = join(runtime, 'lib/node_modules/@oai/browser-desktop/environment-docs/fixture');
  const protocol = join(maka, 'platform/computer-use/src');
  mkdirSync(docs, { recursive: true });
  mkdirSync(protocol, { recursive: true });
  writeFileSync(
    join(runtime, 'manifest.json'),
    JSON.stringify({
      platform: 'linux',
      arch: 'x64',
      runtime_archive_version: 'fixture-runtime',
      node_modules: 'lib/node_modules',
    }),
  );
  writeFileSync(join(docs, 'api.json'), JSON.stringify(api()));
  writeFileSync(join(docs, 'documents.json'), '[]');
  writeFileSync(
    join(protocol, 'protocol.rs'),
    'pub enum Command {\n    Observe,\n}\npub enum Action {\n    Click,\n}\n',
  );
  const output = join(root, 'inventory.json');
  const command = [
    join(import.meta.dirname, 'inventory.mjs'),
    '--runtime',
    runtime,
    '--maka',
    maka,
    '--output',
    output,
  ];
  execFileSync(process.execPath, command);
  const result = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.browser_profiles[0].member_count, 3);
  assert.equal(result.browser_registry, null);
  assert.equal(result.unknowns[0].kind, 'parser-not-provided');
  assert.equal(result.coverage.truncation, false);
  assert.ok(!JSON.stringify(result).includes('matched_for_recorded_scope'));
  const before = readFileSync(output);
  assert.equal(spawnSync(process.execPath, command).status, 2);
  assert.deepEqual(readFileSync(output), before);
  const forbidden = [...command.slice(0, -1), join(maka, 'inventory.json')];
  assert.equal(spawnSync(process.execPath, forbidden).status, 2);
  assert.equal(inventory({ runtime, makaRoot: maka }).target.runtime, 'fixture-runtime');
  unlinkSync(join(docs, 'documents.json'));
  const withoutDocuments = inventory({ runtime, makaRoot: maka });
  assert.equal(withoutDocuments.browser_profiles[0].member_count, 3);
  assert.equal(withoutDocuments.browser_profiles[0].document_manifest_present, false);
  assert.equal(withoutDocuments.unknowns[0].kind, 'missing-document-conditions');
  const parserDirectory = join(root, 'fixture-parser');
  mkdirSync(parserDirectory);
  const parserModule = join(parserDirectory, 'index.cjs');
  const parserManifest = join(parserDirectory, 'package.json');
  writeFileSync(parserModule, 'exports.parse = () => ({program:{body:[]}});');
  writeFileSync(parserManifest, '{"name":"synthetic-parser","version":"0"}');
  const manifestBefore = readFileSync(parserManifest);
  const overwriteParserInput = [
    ...command.slice(0, -1),
    parserManifest,
    '--parser-module',
    parserModule,
    '--overwrite',
  ];
  assert.equal(spawnSync(process.execPath, overwriteParserInput).status, 2);
  assert.deepEqual(readFileSync(parserManifest), manifestBefore);
});

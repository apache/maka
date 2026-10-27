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

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const propertyName = (node) =>
  node?.name ?? (typeof node?.value === 'string' ? node.value : undefined);
const objectProperties = (node) =>
  node?.type === 'ObjectExpression'
    ? node.properties.filter(
        (p) => p.type === 'ObjectProperty' || p.type === 'Property' || p.type === 'ObjectMethod',
      )
    : [];
const property = (node, key) =>
  objectProperties(node).find((p) => !p.computed && propertyName(p.key) === key);
const unique = (values) => [...new Set(values)].sort();

function walk(node, visit, parents = []) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parents);
  for (const [key, value] of Object.entries(node)) {
    if (
      [
        'loc',
        'extra',
        'comments',
        'tokens',
        'leadingComments',
        'trailingComments',
        'innerComments',
      ].includes(key)
    )
      continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) walk(child, visit, [...parents, node]);
    } else if (value?.type) walk(value, visit, [...parents, node]);
  }
}

function source(path, label = path) {
  const bytes = readFileSync(path);
  return { path: label, sha256: sha256(bytes), bytes: bytes.length };
}

function pointer(origin, node) {
  return { ...origin, offset_unit: 'utf16-code-units', start: node.start, end: node.end };
}

function memberPointer(origin, ...keys) {
  const escape = (key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
  return { ...origin, json_pointer: `/${keys.map(escape).join('/')}` };
}

function files(root) {
  const found = [];
  const omissions = [];
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        omissions.push({ path: relative(root, path), reason: 'symlink-not-followed' });
      else if (entry.isDirectory()) scan(path);
      else if (entry.isFile()) found.push(path);
      else omissions.push({ path: relative(root, path), reason: 'not-a-regular-file' });
    }
  }
  scan(root);
  return { files: found, omissions };
}

function loadParser(modulePath, runtime) {
  if (!modulePath) return null;
  const path = realpathSync(resolve(modulePath));
  if (path === runtime || path.startsWith(`${runtime}${sep}`))
    throw new Error('The development parser must be outside the target runtime');
  const parser = createRequire(import.meta.url)(path);
  if (typeof parser.parse !== 'function')
    throw new Error('--parser-module must export a Babel-compatible parse function');
  let directory = dirname(path);
  let packageIdentity = null;
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const data = readJson(manifest);
      packageIdentity = {
        name: data.name ?? null,
        version: data.version ?? null,
        manifest: source(manifest),
      };
      break;
    }
    directory = dirname(directory);
  }
  return {
    identity: { module: source(path), package: packageIdentity },
    parse(text, typescript = false) {
      const result = parser.parse(text, {
        sourceType: 'unambiguous',
        plugins: typescript ? ['typescript'] : [],
      });
      return result.program ?? result;
    },
  };
}

function topBindings(ast) {
  const bindings = new Map();
  for (const statement of ast.body) {
    if (statement.type === 'FunctionDeclaration') {
      bindings.set(statement.id.name, statement);
      continue;
    }
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== 'Identifier') continue;
      const name = declaration.id.name;
      bindings.set(name, bindings.has(name) ? null : declaration.init);
    }
  }
  return bindings;
}

function resolveNode(node, bindings, seen = new Set()) {
  if (node?.type !== 'Identifier') return node;
  if (seen.has(node.name)) return null;
  seen.add(node.name);
  return resolveNode(bindings.get(node.name), bindings, seen);
}

function staticString(node, bindings, seen = new Set()) {
  if (node?.type === 'Identifier') {
    if (seen.has(node.name)) return null;
    seen.add(node.name);
    return staticString(bindings.get(node.name), bindings, seen);
  }
  const value = node;
  if (
    value?.type === 'StringLiteral' ||
    (value?.type === 'Literal' && typeof value.value === 'string')
  )
    return value.value;
  if (value?.type === 'ArrowFunctionExpression' || value?.type === 'FunctionExpression') {
    if (value.body.type !== 'BlockStatement') return staticString(value.body, bindings, seen);
    if (value.body.body.length === 1 && value.body.body[0].type === 'ReturnStatement')
      return staticString(value.body.body[0].argument, bindings, seen);
  }
  return null;
}

export function browserRegistry(ast, origin) {
  const bindings = topBindings(ast);
  const commands = [];
  const capabilities = [];
  const unknowns = [];
  walk(ast, (node, parents) => {
    if (
      ['ObjectProperty', 'Property'].includes(node.type) &&
      !node.computed &&
      propertyName(node.key) === 'commandType'
    ) {
      const command = staticString(node.value, bindings);
      const call = parents.at(-2);
      const alias =
        call?.type === 'CallExpression' && call.arguments[0]?.type === 'Identifier'
          ? call.arguments[0].name
          : null;
      const row = { command, registry_alias: alias, source: pointer(origin, node) };
      if (command) commands.push(row);
      else unknowns.push({ kind: 'unresolved-command-type', source: row.source });
    }
    if (node.type !== 'CallExpression' || node.arguments[0]?.type !== 'ObjectExpression') return;
    const registration = node.arguments[0];
    const implementation = property(registration, 'capability');
    const info = property(registration, 'info');
    if (!implementation || !info) return;
    const information = resolveNode(info.value, bindings);
    const id = staticString(property(information, 'id')?.value, bindings);
    const classNode = resolveNode(implementation.value, bindings);
    const methods =
      classNode?.type === 'ClassExpression'
        ? classNode.body.body
            .filter(
              (item) => item.type === 'ClassMethod' && item.kind === 'method' && !item.computed,
            )
            .map((item) => propertyName(item.key))
        : [];
    if (classNode?.type === 'ClassExpression') {
      for (const item of classNode.body.body) {
        if (item.type === 'ClassMethod' && item.kind === 'method' && item.computed)
          unknowns.push({ kind: 'computed-capability-method', source: pointer(origin, item) });
        else if (
          item.type === 'ClassProperty' &&
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(item.value?.type)
        ) {
          if (item.computed)
            unknowns.push({ kind: 'computed-capability-method', source: pointer(origin, item) });
          else methods.push(propertyName(item.key));
        }
      }
    }
    const factory = node.callee.type === 'Identifier' ? resolveNode(node.callee, bindings) : null;
    const factoryMethods = [];
    if (factory)
      walk(factory, (n) => {
        if (n.type === 'ClassMethod' && n.kind === 'method' && !n.computed)
          factoryMethods.push(propertyName(n.key));
        else if (n.type === 'ClassMethod' && n.kind === 'method' && n.computed)
          unknowns.push({ kind: 'computed-capability-factory-method', source: pointer(origin, n) });
      });
    if (id)
      capabilities.push({
        id,
        callable_members: unique([...methods, ...factoryMethods]),
        declared_instance_fields:
          classNode?.type === 'ClassExpression'
            ? unique(
                classNode.body.body
                  .filter((item) => item.type === 'ClassProperty' && !item.computed && !item.static)
                  .map((item) => propertyName(item.key)),
              )
            : [],
        callable_scope:
          'Direct callable syntax only; injected instance fields and runtime-created namespaces are not inferred to be callable.',
        direct_class_members: unique(methods),
        factory_class_members: unique(factoryMethods),
        source: pointer(origin, registration),
      });
    else
      unknowns.push({
        kind: 'unresolved-capability-registration',
        source: pointer(origin, registration),
      });
  });
  return {
    extraction:
      'Complete AST traversal of commandType properties and capability/info registrations; dynamic or differently shaped registries remain unknown',
    command_type_properties:
      commands.length + unknowns.filter((row) => row.kind === 'unresolved-command-type').length,
    commands,
    capabilities,
    unknowns,
  };
}

export function machineApi(api, documents, apiSource, documentsSource, parser) {
  if (
    !api ||
    typeof api.interfaces !== 'object' ||
    typeof api.types !== 'object' ||
    !Array.isArray(documents)
  )
    throw new Error('Unrecognized machine API/document manifest structure');
  const members = [];
  const types = [];
  const unknowns = [];
  for (const [interfaceName, fields] of Object.entries(api.interfaces)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields))
      throw new Error(`Invalid interface ${interfaceName}`);
    for (const [name, value] of Object.entries(fields)) {
      if (!Array.isArray(value.declarations))
        throw new Error(`Missing declarations for ${interfaceName}.${name}`);
      const flags = value.unsupportedByDefaultIn ?? [];
      members.push({
        id: `${interfaceName}.${name}`,
        interface: interfaceName,
        name,
        documented: value.documented !== false,
        declaration_count: value.declarations.length,
        references: unique(
          value.declarations.flatMap((declaration) => declaration.references ?? []),
        ),
        unsupported_by_default_in: flags,
        backend_declarations: Object.fromEntries(
          ['iab', 'extension', 'cdp'].map((backend) => [
            backend,
            flags.includes(backend) ? 'disabled-by-default' : 'not-disabled-by-this-member',
          ]),
        ),
        behavior: 'unverified',
        source: memberPointer(apiSource, 'interfaces', interfaceName, name),
      });
      const unknown = Object.keys(value).filter(
        (key) => !['declarations', 'documented', 'unsupportedByDefaultIn'].includes(key),
      );
      if (unknown.length)
        unknowns.push({
          kind: 'uninterpreted-member-metadata',
          member: `${interfaceName}.${name}`,
          keys: unknown,
        });
    }
  }
  for (const [name, value] of Object.entries(api.types)) {
    const row = {
      name,
      references: value.references ?? [],
      members: null,
      source: memberPointer(apiSource, 'types', name),
    };
    if (parser) {
      try {
        const ast = parser.parse(value.text, true);
        const declaration = ast.body.find(
          (node) =>
            ['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(node.type) &&
            node.id.name === name,
        );
        if (!declaration) throw new Error('expected named type declaration');
        const body = declaration.typeAnnotation ?? declaration.body;
        row.members = (body.members ?? body.body ?? [])
          .filter(
            (node) => node.type === 'TSMethodSignature' || node.type === 'TSPropertySignature',
          )
          .map((node) => ({
            name: propertyName(node.key) ?? null,
            kind: node.type === 'TSMethodSignature' ? 'method' : 'property',
          }));
        row.syntax = body.type;
      } catch {
        unknowns.push({ kind: 'unparsed-type-alias', type: name });
      }
    }
    types.push(row);
  }
  function referencedInterfaces(name, seen = new Set()) {
    if (seen.has(name)) return [];
    seen.add(name);
    if (api.interfaces[name]) return [name];
    return (api.types[name]?.references ?? []).flatMap((reference) =>
      referencedInterfaces(reference, seen),
    );
  }
  for (const backend of ['iab', 'extension', 'cdp']) {
    const reachable = new Set([api.root]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of members) {
        if (!reachable.has(row.interface) || row.unsupported_by_default_in.includes(backend))
          continue;
        for (const name of row.references.flatMap((reference) => referencedInterfaces(reference))) {
          if (!reachable.has(name)) {
            reachable.add(name);
            changed = true;
          }
        }
      }
    }
    for (const row of members) {
      row.default_graph_reachability ??= {};
      row.default_graph_reachability[backend] = row.unsupported_by_default_in.includes(backend)
        ? 'member-disabled-by-default'
        : reachable.has(row.interface)
          ? 'declared-reference-path-exists'
          : 'no-default-reference-path';
    }
  }
  const conditions = documents.map((row, index) => {
    const known = [
      'browserTypes',
      'requiredApiMembers',
      'requiredBrowserCapabilities',
      'requiredTabCapabilities',
      'excludedTabCapabilities',
      'excludedBrowserCapabilities',
    ];
    const unknown = Object.keys(row.when ?? {}).filter((key) => !known.includes(key));
    if (unknown.length)
      unknowns.push({
        kind: 'uninterpreted-document-conditions',
        document: row.name,
        keys: unknown,
      });
    return {
      name: row.name,
      mode: row.mode,
      required_commands: row.requiredFor ?? [],
      conditions: Object.fromEntries(
        Object.entries(row.when ?? {}).filter(([key]) => known.includes(key)),
      ),
      source: memberPointer(documentsSource, index),
    };
  });
  return {
    root_interface: api.root,
    interface_count: Object.keys(api.interfaces).length,
    member_count: members.length,
    named_type_count: types.length,
    document_count: conditions.length,
    members,
    types,
    document_conditions: conditions,
    unknowns,
  };
}

function bodyOf(member) {
  let body = member.type === 'ObjectMethod' ? member.body : member.value?.body;
  const expression =
    body?.type === 'BlockStatement' &&
    body.body.length === 1 &&
    body.body[0].type === 'ReturnStatement'
      ? body.body[0].argument
      : body;
  if (expression?.type === 'CallExpression') {
    const generator = expression.arguments.at(-1);
    if (generator?.type === 'FunctionExpression' && generator.generator) body = generator.body;
  }
  return body;
}

function surfaceObject(node, origin) {
  if (node?.type !== 'ObjectExpression') return null;
  const members = objectProperties(node)
    .filter((p) => !p.computed)
    .map((p) => {
      const body = bodyOf(p);
      let throws = 0;
      const argumentFields = [];
      if (body)
        walk(body, (n) => {
          if (n.type === 'ThrowStatement') throws++;
          if (n.type === 'ObjectProperty' && !n.computed && propertyName(n.key))
            argumentFields.push(propertyName(n.key));
        });
      return {
        name: propertyName(p.key),
        syntax:
          body?.type === 'BlockStatement' && body.body[0]?.type === 'ThrowStatement'
            ? 'always-throws'
            : throws
              ? 'contains-refusal-branch'
              : 'member-declared',
        object_member_names_in_body: unique(argumentFields),
        source: pointer(origin, p),
      };
    });
  const unknowns = [];
  for (const entry of node.properties.filter((p) => p.type === 'SpreadElement' || p.computed)) {
    if (entry.computed) {
      unknowns.push({ kind: 'dynamic-object-member', source: pointer(origin, entry) });
      continue;
    }
    const branches =
      entry.argument.type === 'ObjectExpression'
        ? [entry.argument]
        : entry.argument.type === 'ConditionalExpression' &&
            [entry.argument.consequent, entry.argument.alternate].every(
              (branch) => branch.type === 'ObjectExpression',
            )
          ? [entry.argument.consequent, entry.argument.alternate]
          : null;
    if (!branches) {
      unknowns.push({ kind: 'dynamic-object-member', source: pointer(origin, entry) });
      continue;
    }
    for (const [index, branch] of branches.entries()) {
      const nested = surfaceObject(branch, origin);
      const test = entry.argument.type === 'ConditionalExpression' ? entry.argument.test : null;
      const recognizedPlatform =
        test?.type === 'BinaryExpression' &&
        test.left.type === 'Identifier' &&
        test.left.name === 'nativePlatform' &&
        ['===', '==', '!==', '!='].includes(test.operator) &&
        ['mac', 'linux', 'windows'].includes(test.right.value);
      const platforms = recognizedPlatform
        ? ['mac', 'linux', 'windows'].filter((name) => {
            const result = ['===', '=='].includes(test.operator)
              ? name === test.right.value
              : name !== test.right.value;
            return index === 0 ? result : !result;
          })
        : null;
      members.push(
        ...nested.members.map((member) => ({
          ...member,
          availability: branches.length > 1 ? 'conditional-source-literal' : 'literal-spread',
          condition_source: pointer(origin, entry),
          ...(platforms
            ? {
                platforms: member.platforms
                  ? member.platforms.filter((name) => platforms.includes(name))
                  : platforms,
              }
            : {}),
        })),
      );
      unknowns.push(...nested.unknowns);
    }
  }
  return { members, unknowns };
}

export function unifiedSurface(ast, origin) {
  const targets = [];
  const lowLevel = [];
  const rootContributions = [];
  walk(ast, (node, parents) => {
    if (node.type !== 'ObjectExpression') return;
    const keys = objectProperties(node).map((p) => propertyName(p.key));
    const branch = parents.findLast(
      (p) => p.type === 'SwitchCase' && ['mac', 'linux', 'windows'].includes(p.test?.value),
    );
    if (
      keys.some((key) =>
        [
          'getState',
          'getBrowser',
          'getApp',
          'listWindows',
          'listApps',
          'createBrowserTab',
        ].includes(key),
      )
    )
      rootContributions.push({
        platform: branch?.test.value ?? 'common-or-configuration-dependent',
        ...surfaceObject(node, origin),
      });
    if (!keys.includes('getAXState') || !keys.includes('selectText')) return;
    targets.push({
      kind: branch ? 'app' : 'browser-tab',
      platform: branch?.test.value ?? 'browser-backend',
      ...surfaceObject(node, origin),
    });
  });
  walk(ast, (node) => {
    if (
      node.type !== 'AssignmentExpression' ||
      node.left.type !== 'MemberExpression' ||
      node.left.computed
    )
      return;
    const name = propertyName(node.left.property);
    if (['start_audio_recording', 'stop_audio_recording'].includes(name))
      lowLevel.push({ name, source: pointer(origin, node) });
  });
  return {
    root_contributions: rootContributions,
    targets,
    computer_assignments: lowLevel,
    behavior: 'unverified',
  };
}

export function nativeClientSurface(ast, origin, platform) {
  const members = [];
  const unknowns = [];
  walk(ast, (node) => {
    if (node.type === 'ObjectExpression') {
      const keys = objectProperties(node).map((p) => propertyName(p.key));
      if (
        property(node, 'target')?.value?.value === platform ||
        keys.includes('start_audio_recording') ||
        keys.includes('stop_audio_recording')
      ) {
        const surface = surfaceObject(node, origin);
        members.push(...surface.members);
        unknowns.push(...surface.unknowns);
      }
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.left.type === 'MemberExpression' &&
      node.left.object.type === 'ThisExpression' &&
      !node.left.computed
    ) {
      const name = propertyName(node.left.property);
      if (name && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.right.type))
        members.push({
          name,
          syntax: 'instance-callable-assignment',
          source: pointer(origin, node),
        });
      else if (name === 'target' && node.right.value === platform)
        members.push({ name, syntax: 'instance-target-assignment', source: pointer(origin, node) });
    }
    if (node.type === 'ExportNamedDeclaration') {
      for (const specifier of node.specifiers) {
        const name = propertyName(specifier.exported);
        if (['start_audio_recording', 'stop_audio_recording'].includes(name))
          members.push({
            name,
            syntax: 'audio-function-export',
            source: pointer(origin, specifier),
          });
      }
    }
  });
  return {
    platform,
    members,
    unknowns,
    behavior: 'unverified',
    extraction:
      'Target-tagged client literals, audio literals/exports and directly assigned instance callables. Native binary exports and configuration-dependent attachment remain outside this syntax inventory.',
  };
}

function unfreeze(node) {
  return node?.type === 'CallExpression' &&
    node.callee.object?.name === 'Object' &&
    propertyName(node.callee.property) === 'freeze'
    ? node.arguments[0]
    : node;
}

export function makaSurface(ast, origin) {
  let root = null;
  let agent = null;
  let common = null;
  const tab = [];
  const app = [];
  let browser = null;
  const unknowns = [];
  walk(ast, (node, parents) => {
    if (
      node.type === 'CallExpression' &&
      propertyName(node.callee.property) === 'defineProperty' &&
      node.arguments[0]?.name === 'globalThis'
    ) {
      const name = node.arguments[1]?.value;
      const value = unfreeze(property(node.arguments[2], 'value')?.value);
      if (name === 'cua') root = value;
      if (name === 'agent') agent = value;
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id.name === 'target' &&
      parents.some(
        (p) =>
          ['FunctionDeclaration', 'VariableDeclarator'].includes(p.type) && p.id?.name === 'bind',
      )
    )
      common = node.init;
    if (
      node.type === 'CallExpression' &&
      propertyName(node.callee.property) === 'assign' &&
      node.arguments[0]?.name === 'target'
    ) {
      const condition = parents.findLast((p) => p.type === 'IfStatement');
      const test = condition?.test;
      if (
        test?.type === 'BinaryExpression' &&
        test.right.value === 'tab' &&
        condition.consequent.start <= node.start &&
        node.end <= condition.consequent.end
      )
        tab.push(node.arguments[1]);
      else if (
        test?.type === 'BinaryExpression' &&
        test.right.value === 'tab' &&
        condition.alternate?.start <= node.start &&
        node.end <= condition.alternate?.end
      )
        app.push(node.arguments[1]);
    }
    if (
      node.type === 'ObjectExpression' &&
      property(node, 'browserId') &&
      property(node, 'documentation') &&
      parents.some((p) => propertyName(p.key) === 'getBrowser')
    )
      browser = node;
  });
  if (!root) unknowns.push({ kind: 'unresolved-cua-root' });
  const unresolvedCommon = common?.type !== 'ObjectExpression';
  if (unresolvedCommon) unknowns.push({ kind: 'unresolved-bound-target-literal' });
  if (!browser) unknowns.push({ kind: 'unresolved-browser-return-literal' });
  const shapes = {
    Unified: surfaceObject(root, origin),
    Agent: surfaceObject(agent, origin),
    Browser: surfaceObject(browser, origin),
    Tab: {
      members: [common, ...tab].flatMap((node) => surfaceObject(node, origin)?.members ?? []),
      unknowns: [common, ...tab]
        .flatMap((node) => surfaceObject(node, origin)?.unknowns ?? [])
        .concat(unresolvedCommon ? [{ kind: 'unresolved-bound-target-literal' }] : []),
    },
    App: {
      members: [common, ...app].flatMap((node) => surfaceObject(node, origin)?.members ?? []),
      unknowns: [common, ...app]
        .flatMap((node) => surfaceObject(node, origin)?.unknowns ?? [])
        .concat(unresolvedCommon ? [{ kind: 'unresolved-bound-target-literal' }] : []),
    },
  };
  const child = (node, name) => unfreeze(property(node, name)?.value);
  const children = {
    Computer: child(root, 'computer'),
    Browsers: child(agent, 'browsers'),
    Documentation: child(agent, 'documentation'),
    Tabs: child(browser, 'tabs'),
    BrowserUser: child(browser, 'user'),
    BrowserCapabilityCollection: child(browser, 'capabilities'),
  };
  for (const [name, field] of Object.entries({
    AXAPI: 'ax',
    ContentAPI: 'content',
    CUAAPI: 'cua',
    DomCUAAPI: 'dom_cua',
    PlaywrightAPI: 'playwright',
    TabClipboardAPI: 'clipboard',
    TabDevAPI: 'dev',
    TabCapabilityCollection: 'capabilities',
  })) {
    children[name] = [common, ...tab].map((node) => child(node, field)).find(Boolean);
  }
  for (const [name, node] of Object.entries(children)) shapes[name] = surfaceObject(node, origin);
  return {
    shapes,
    unknowns,
    extraction:
      'Finite source object literals only; helper-produced, computed and dynamically added interfaces remain unresolved. A same-named member does not prove compatible arguments or behavior.',
  };
}

function compareExposure(profile, maka) {
  return profile.members.map((member) => {
    const shape = maka.shapes[member.interface];
    const found = shape?.members.find((row) => row.name === member.name);
    return {
      member: member.id,
      exposure: found
        ? 'same-named-member-declared'
        : shape?.unknowns.length
          ? 'unresolved-dynamic-surface'
          : shape
            ? 'absent-from-inspected-object-literal'
            : 'interface-not-resolved',
      source: found?.source ?? null,
      syntax: found?.syntax ?? null,
      implementation: 'unverified',
      behavior: 'unverified',
    };
  });
}

function compareUnified(reference, maka) {
  if (!reference || !maka) return null;
  return {
    root: reference.root_contributions.flatMap((surface) =>
      surface.members.map((member) => ({
        platform: surface.platform,
        member: member.name,
        reference_source: member.source,
        maka_source:
          maka.shapes.Unified?.members.find((row) => row.name === member.name)?.source ?? null,
        behavior: 'unverified',
      })),
    ),
    targets: reference.targets.flatMap((surface) =>
      surface.members.map((member) => {
        const shape = maka.shapes[surface.kind === 'app' ? 'App' : 'Tab'];
        const found = shape?.members.find((row) => row.name === member.name);
        return {
          platform: surface.platform,
          kind: surface.kind,
          member: member.name,
          reference_syntax: member.syntax,
          reference_source: member.source,
          maka_exposure: found
            ? 'same-named-member-declared'
            : 'absent-from-inspected-target-literal',
          maka_source: found?.source ?? null,
          implementation: 'unverified',
          behavior: 'unverified',
        };
      }),
    ),
  };
}

function compareNativeClients(clients, maka) {
  if (!maka) return null;
  const computer = maka.shapes.Computer;
  return ['linux', 'mac', 'windows'].map((platform) => ({
    platform,
    members: unique(
      clients
        .filter((row) => row.platform === platform)
        .flatMap((row) => row.members.map((member) => member.name)),
    ).map((name) => {
      const candidate = computer?.members.find(
        (row) => row.name === name && (!row.platforms || row.platforms.includes(platform)),
      );
      return {
        member: name,
        reference_sources: clients
          .filter((row) => row.platform === platform)
          .flatMap((row) =>
            row.members.filter((member) => member.name === name).map((member) => member.source),
          ),
        maka_exposure: candidate
          ? 'same-named-member-declared'
          : computer?.unknowns.length
            ? 'unresolved-dynamic-surface'
            : 'absent-from-inspected-computer-literal',
        maka_source: candidate?.source ?? null,
        maka_availability: candidate?.availability ?? null,
        implementation: 'unverified',
        behavior: 'unverified',
      };
    }),
  }));
}

function caseFamilies(profiles, manifest) {
  const declared = new Set(manifest.cases.map((row) => row.id));
  const byInterface = {
    BrowserUser: ['browser.user-tab-claim'],
    Tabs: ['browser.turn-cleanup', 'browser.visibility-and-session-name'],
    Tab: [
      'browser.navigation-and-origin-approval',
      'browser.form-and-screenshot',
      'browser.turn-cleanup',
    ],
    AXAPI: ['browser.form-and-screenshot', 'browser.frames-and-stale-nodes'],
  };
  const memberNames = unique(profiles.flatMap((profile) => profile.members.map((row) => row.id)));
  return {
    scope:
      'Related scenario families only; these links are not per-member execution receipts or proof that every overload and failure case is exercised.',
    interfaces: unique(
      profiles.flatMap((profile) => profile.members.map((row) => row.interface)),
    ).map((name) => ({
      interface: name,
      members: memberNames.filter((id) => id.startsWith(`${name}.`)),
      related_initial_cases: (byInterface[name] ?? []).filter((id) => declared.has(id)),
      behavior_coverage: 'unverified',
    })),
    members_without_related_initial_scenario: memberNames.filter(
      (id) => !(byInterface[id.split('.')[0]] ?? []).length,
    ),
  };
}

function rustVariants(path, enumName, label) {
  const text = readFileSync(path, 'utf8');
  const header = new RegExp(`pub enum ${enumName}\\s*\\{`, 'g');
  const matches = [...text.matchAll(header)];
  if (matches.length !== 1)
    return { variants: [], unknowns: [`Cannot uniquely locate ${enumName}`] };
  const start = matches[0].index + matches[0][0].length;
  let depth = 1;
  let end = start;
  for (; end < text.length && depth; end++) {
    if (text[end] === '{') depth++;
    if (text[end] === '}') depth--;
  }
  if (depth) return { variants: [], unknowns: [`Unclosed ${enumName} declaration`] };
  const variants = [
    ...text.slice(start, end - 1).matchAll(/^    ([A-Z][A-Za-z0-9_]*)\s*(?:\{|,)/gm),
  ].map((match) => ({
    name: match[1],
    source: {
      ...source(path, label),
      offset_unit: 'utf16-code-units',
      start: start + match.index,
      end: start + match.index + match[0].length,
    },
  }));
  return {
    variants,
    unknowns: variants.length ? [] : [`No formatted variants found in ${enumName}`],
    extraction:
      'Entire named Rust enum block; variant declarations at its four-space indentation. This is protocol exposure, not dispatch implementation.',
  };
}

export function inventory({ runtime, makaRoot, parserModule }) {
  runtime = realpathSync(resolve(runtime));
  makaRoot = realpathSync(resolve(makaRoot));
  const manifestPath = join(runtime, 'manifest.json');
  const manifest = readJson(manifestPath);
  const moduleRelative = manifest.node_modules;
  if (typeof moduleRelative !== 'string' || isAbsolute(moduleRelative))
    throw new Error('Runtime manifest must name a relative node_modules directory');
  const modules = realpathSync(join(runtime, moduleRelative));
  if (!modules.startsWith(`${runtime}${sep}`))
    throw new Error('Runtime node_modules escapes the selected runtime');
  const oai = join(modules, '@oai');
  const browserRoot = join(oai, 'browser-desktop');
  const packageFiles = files(browserRoot);
  const parser = loadParser(parserModule, runtime);
  const sources = [source(manifestPath, 'manifest.json')];
  const unknowns = [];
  const profiles = [];
  const docsRoot = join(browserRoot, 'environment-docs');
  for (const apiPath of packageFiles.files.filter(
    (path) => path.startsWith(`${docsRoot}${sep}`) && path.endsWith(`${sep}api.json`),
  )) {
    const directory = dirname(apiPath);
    const documentsPath = join(directory, 'documents.json');
    const hasDocuments = existsSync(documentsPath);
    if (!hasDocuments) {
      unknowns.push({
        kind: 'missing-document-conditions',
        profile: relative(docsRoot, directory),
      });
    }
    const apiSource = source(
      apiPath,
      `@oai/browser-desktop/${relative(browserRoot, apiPath).split(sep).join('/')}`,
    );
    const documentsSource = hasDocuments
      ? source(
          documentsPath,
          `@oai/browser-desktop/${relative(browserRoot, documentsPath).split(sep).join('/')}`,
        )
      : null;
    sources.push(apiSource);
    if (documentsSource) sources.push(documentsSource);
    profiles.push({
      profile: relative(docsRoot, directory).split(sep).join('/'),
      document_manifest_present: hasDocuments,
      ...machineApi(
        readJson(apiPath),
        hasDocuments ? readJson(documentsPath) : [],
        apiSource,
        documentsSource,
        parser,
      ),
    });
  }
  if (!profiles.length) throw new Error('No machine-readable browser API profiles were found');
  let registry = null;
  let unified = null;
  let maka = null;
  const nativeClients = [];
  const protocolPath = join(makaRoot, 'platform/computer-use/src/protocol.rs');
  const protocol = {
    commands: rustVariants(protocolPath, 'Command', 'platform/computer-use/src/protocol.rs'),
    actions: rustVariants(protocolPath, 'Action', 'platform/computer-use/src/protocol.rs'),
  };
  sources.push(source(protocolPath, 'maka/platform/computer-use/src/protocol.rs'));
  if (parser) {
    for (const [kind, path, label] of [
      [
        'registry',
        join(browserRoot, 'scripts/browser-client.mjs'),
        '@oai/browser-desktop/scripts/browser-client.mjs',
      ],
      [
        'unified',
        join(oai, 'cua/dist/lib/js/oai_js_cua/src/tinysky_alt/create_tinysky_alt.js'),
        '@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/create_tinysky_alt.js',
      ],
      [
        'maka',
        join(makaRoot, 'platform/computer-use/src/facade.js'),
        'maka/platform/computer-use/src/facade.js',
      ],
    ]) {
      if (!existsSync(path)) {
        unknowns.push({ kind: 'selected-source-missing', source: label });
        continue;
      }
      const origin = source(path, label);
      sources.push(origin);
      try {
        const ast = parser.parse(readFileSync(path, 'utf8'));
        if (kind === 'registry') registry = browserRegistry(ast, origin);
        if (kind === 'unified') unified = unifiedSurface(ast, origin);
        if (kind === 'maka') maka = makaSurface(ast, origin);
      } catch (error) {
        unknowns.push({
          kind: 'parse-failed',
          source: label,
          parser_error: error.reasonCode ?? error.code ?? error.name,
        });
      }
    }
    for (const [platform, name] of [
      ['linux', 'targets/linux/create_client.js'],
      ['linux', 'targets/linux/audio_recording.js'],
      ['mac', 'targets/mac/create_client.js'],
      ['mac', 'targets/mac/audio_recording.js'],
      ['windows', 'targets/windows/internal/computer_use_client_base.js'],
    ]) {
      const path = join(oai, 'sky/dist/project/cua/sky_js/src', name);
      const label = `@oai/sky/dist/project/cua/sky_js/src/${name}`;
      if (!existsSync(path)) {
        unknowns.push({ kind: 'selected-native-source-missing', platform, source: label });
        continue;
      }
      const origin = source(path, label);
      sources.push(origin);
      try {
        nativeClients.push(
          nativeClientSurface(parser.parse(readFileSync(path, 'utf8')), origin, platform),
        );
      } catch (error) {
        unknowns.push({
          kind: 'native-client-parse-failed',
          platform,
          source: label,
          parser_error: error.reasonCode ?? error.code ?? error.name,
        });
      }
    }
  } else
    unknowns.push({
      kind: 'parser-not-provided',
      scopes: ['client-command-registry', 'unified-facade', 'maka-facade', 'type-alias-members'],
    });
  const comparisons = maka
    ? profiles.map((profile) => ({
        profile: profile.profile,
        members: compareExposure(profile, maka),
      }))
    : [];
  const caseManifestPath = join(makaRoot, 'scripts/computer-use-parity/cases.json');
  const initialCases = existsSync(caseManifestPath) ? readJson(caseManifestPath) : null;
  if (initialCases)
    sources.push(source(caseManifestPath, 'maka/scripts/computer-use-parity/cases.json'));
  return {
    scope:
      'Static inventory of declared members and selected client/facade syntax. No target execution, native behavior, permission enforcement, browser action or complete product parity is established.',
    target: {
      runtime_path: runtime,
      platform: manifest.platform ?? null,
      architecture: manifest.arch ?? null,
      runtime: manifest.runtime_archive_version ?? null,
      app_version: null,
      app_version_observation:
        'Not available from the runtime manifest; this tool does not select or authenticate an app.',
    },
    tooling: {
      node: process.version,
      parser: parser?.identity ?? null,
      inventory_tool: source(fileURLToPath(import.meta.url)),
      invocation: process.argv,
      cwd: process.cwd(),
    },
    sources,
    coverage: {
      browser_package_files: packageFiles.files.length,
      browser_package_omissions: packageFiles.omissions,
      profiles: profiles.length,
      interface_member_rows: profiles.reduce((count, profile) => count + profile.members.length, 0),
      document_condition_rows: profiles.reduce(
        (count, profile) => count + profile.document_conditions.length,
        0,
      ),
      unique_interface_members: unique(
        profiles.flatMap((profile) => profile.members.map((row) => row.id)),
      ).length,
      registry_command_count: registry?.commands.length ?? null,
      unique_registry_commands: registry
        ? unique(registry.commands.map((row) => row.command)).length
        : null,
      registry_unknown_count: registry?.unknowns.length ?? null,
      registry_capability_count: registry?.capabilities.length ?? null,
      truncation: false,
      machine_profile_unknown_count: profiles.reduce(
        (count, profile) => count + profile.unknowns.length,
        0,
      ),
      maka_dynamic_shape_unknown_count: maka
        ? maka.unknowns.length +
          Object.values(maka.shapes).reduce(
            (count, shape) => count + (shape?.unknowns.length ?? 0),
            0,
          )
        : null,
      maka_unresolved_interface_members: maka
        ? unique(
            comparisons.flatMap((profile) =>
              profile.members
                .filter((member) =>
                  ['interface-not-resolved', 'unresolved-dynamic-surface'].includes(
                    member.exposure,
                  ),
                )
                .map((member) => member.member),
            ),
          ).length
        : null,
      native_client_member_names: Object.fromEntries(
        ['linux', 'mac', 'windows'].map((platform) => [
          platform,
          unique(
            nativeClients
              .filter((row) => row.platform === platform)
              .flatMap((row) => row.members.map((member) => member.name)),
          ),
        ]),
      ),
      unselected_scope:
        'Browser service/provider implementations, native helpers, application host services and dynamic runtime capability overrides remain unverified.',
    },
    browser_profiles: profiles,
    browser_registry: registry,
    unified_facade: unified,
    native_clients: nativeClients,
    maka_facade: maka,
    maka_protocol: protocol,
    comparisons,
    unified_comparison: compareUnified(unified, maka),
    native_client_comparison: compareNativeClients(nativeClients, maka),
    case_family_mapping: initialCases ? caseFamilies(profiles, initialCases) : null,
    unknowns,
    evidence_policy:
      'Names, structured availability flags and identities only; declaration text, descriptions, documentation bodies, source fragments and application binaries are intentionally excluded.',
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      runtime: { type: 'string' },
      maka: { type: 'string', default: resolve(import.meta.dirname, '../..') },
      'parser-module': { type: 'string' },
      output: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
    },
  });
  if (!values.runtime || !values.output)
    throw new Error(
      'Usage: node inventory.mjs --runtime /installed/app/resources/cua_node --output /private/new-inventory.json [--maka /source/maka] [--parser-module /existing/@babel/parser/lib/index.js] [--overwrite]',
    );
  const result = inventory({
    runtime: values.runtime,
    makaRoot: values.maka,
    parserModule: values['parser-module'],
  });
  const requestedOutput = resolve(values.output);
  const output = join(realpathSync(dirname(requestedOutput)), basename(requestedOutput));
  const protectedRoots = [
    realpathSync(resolve(values.runtime)),
    realpathSync(resolve(values.maka)),
  ];
  const destination = existsSync(output) ? realpathSync(output) : output;
  if (
    protectedRoots.some((root) => destination === root || destination.startsWith(`${root}${sep}`))
  )
    throw new Error('Inventory output must be outside the runtime and source repository');
  if (existsSync(output) && statSync(output).nlink > 1)
    throw new Error('Inventory output cannot replace a hard-linked file');
  const parserInputs = [
    result.tooling.parser?.module.path,
    result.tooling.parser?.package?.manifest.path,
  ].filter(Boolean);
  if (parserInputs.some((path) => realpathSync(path) === destination))
    throw new Error('Inventory output would overwrite a parser input');
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    flag: values.overwrite ? 'w' : 'wx',
  });
  console.log(
    JSON.stringify(
      {
        output,
        coverage: result.coverage,
        profiles: result.browser_profiles.map((profile) => ({
          name: profile.profile,
          interfaces: profile.interface_count,
          members: profile.member_count,
          named_types: profile.named_type_count,
          documents: profile.document_count,
        })),
        unknowns: result.unknowns,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

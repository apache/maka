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

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const STATEFUL_HOOKS = new Set([
  'use',
  'useActionState',
  'useDeferredValue',
  'useEffect',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useOptimistic',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
]);
const REACT_LIFECYCLE_METHODS = new Set([
  'UNSAFE_componentWillMount',
  'UNSAFE_componentWillReceiveProps',
  'UNSAFE_componentWillUpdate',
  'componentDidCatch',
  'componentDidMount',
  'componentDidUpdate',
  'componentWillMount',
  'componentWillReceiveProps',
  'componentWillUnmount',
  'componentWillUpdate',
  'getDerivedStateFromError',
  'getDerivedStateFromProps',
  'getSnapshotBeforeUpdate',
  'shouldComponentUpdate',
]);
const ENVIRONMENT_CALLS = new Set([
  'BroadcastChannel',
  'EventSource',
  'FileReader',
  'IntersectionObserver',
  'MutationObserver',
  'ResizeObserver',
  'SharedWorker',
  'WebSocket',
  'Worker',
  'XMLHttpRequest',
  'addEventListener',
  'cancelAnimationFrame',
  'clearInterval',
  'clearTimeout',
  'fetch',
  'matchMedia',
  'queueMicrotask',
  'requestAnimationFrame',
  'removeEventListener',
  'setInterval',
  'setTimeout',
]);
const ENVIRONMENT_OBJECTS = new Set([
  'document',
  'history',
  'indexedDB',
  'localStorage',
  'location',
  'navigator',
  'sessionStorage',
]);
const FORBIDDEN_ENVIRONMENT_IMPORTS = new Set([
  'electron',
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module.replace(/^node:/u, '')}`),
]);
const SOURCE_EXTENSION = /\.(?:(?:c|m)?(?:js|ts)x?)$/u;
const SOURCE_FILE = SOURCE_EXTENSION;
const DECLARATION_FILE = /\.d\.(?:(?:c|m)?ts)$/u;
const LEGACY_APP_SHELL_FILE = /^(?:app-shell(?:-.+)?|use-app-shell-.+)\.(?:(?:c|m)?(?:js|ts)x?)$/u;
const LEGACY_APP_SHELL_MODULE = 'src/renderer/app-shell';
const LEGACY_APP_SHELL_ADAPTER = 'src/renderer/composition/legacy-desktop-region.tsx';
const RENDERER_ENTRY_INDEX = 'src/renderer/index.html';
const RENDERER_ENTRY_SOURCE = 'src/renderer/main.tsx';
const RENDERER_ENTRY_SCRIPT_SOURCE = '/main.tsx';
const RENDERER_LOADER_SOURCE = 'src/main/main-window.ts';
const MAIN_RENDERER_LOADER_SOURCE = 'src/main/main-renderer-loader.ts';
const RENDERER_VITE_CONFIG = 'vite.config.ts';
const RENDERER_BUILD_SCRIPT =
  'vite build && node scripts/check-renderer-entry-output.mjs && node ../../scripts/check-third-party-notices.mjs';
const DESKTOP_SELF_PREFIX = '@maka/desktop/';
const CAPABILITY_DEBT_METRICS = [
  'actionFactories',
  'bridgePaths',
  'dependencyPaths',
  'environmentCapabilities',
  'hookCalls',
  'lifecycleMethods',
  'unresolvedDependencies',
];
const ROOT_DEBT_METRICS = [
  ...CAPABILITY_DEBT_METRICS,
  'importDeclarations',
  'importSpecifiers',
  'nonTriviaTokens',
];
const DEFAULT_LEGACY_GROWTH_DIRECTORIES = [
  'src/renderer/astryx-theme',
  'src/renderer/computer-use-overlay',
  'src/renderer/locales',
  'src/renderer/settings',
];
const PARSER_PLUGINS = [
  'explicitResourceManagement',
  'importAttributes',
  'jsx',
  'typescript',
];

function normalizePath(value) {
  return value.split(sep).join('/');
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sameJson(left, right) {
  return JSON.stringify(sortedObject(left)) === JSON.stringify(sortedObject(right));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSortedUniqueStrings(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    JSON.stringify(value) === JSON.stringify([...new Set(value)].sort())
  );
}

function validateCountMap(value) {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, count]) => key.length > 0 && Number.isInteger(count) && count >= 0,
    )
  );
}

function controllerOwnersOf(config) {
  return config.controllerOwners ?? [];
}

function controllerOwnerKey(owner) {
  return `${owner.implementation}#${owner.symbol}`;
}

function validateArchitectureConfig(config, label, violations) {
  if (!isRecord(config)) {
    violations.push(`${label} architecture ledger must be an object`);
    return false;
  }
  let valid = true;
  const reject = (message) => {
    valid = false;
    violations.push(`${label} architecture ledger: ${message}`);
  };
  if (config.version !== 1) reject('version must be 1');
  if (!isSortedUniqueStrings(config.legacyRendererFiles)) {
    reject('legacyRendererFiles must be sorted unique strings');
  }
  if (!isSortedUniqueStrings(config.legacyGrowthDirectories)) {
    reject('legacyGrowthDirectories must be sorted unique strings');
  } else if (
    config.legacyGrowthDirectories.some(
      (path) => !path.startsWith('src/renderer/') || path.includes('..') || path.includes('\\'),
    )
  ) {
    reject('legacyGrowthDirectories must contain normalized renderer directories');
  }
  for (const field of ['legacyFeatureImports', 'legacyPlatformImports']) {
    if (!isSortedUniqueStrings(config[field])) reject(`${field} must be sorted unique strings`);
  }
  if (!Array.isArray(controllerOwnersOf(config))) reject('controllerOwners must be an array');
  if (
    !isRecord(config.legacyAppShell) ||
    !isRecord(config.legacyAppShell.files) ||
    !isRecord(config.legacyAppShell.closure)
  ) {
    reject('legacyAppShell.files and legacyAppShell.closure must be objects');
  }
  if (!isRecord(config.rootDebt)) reject('rootDebt must be an object');
  if (!isRecord(config.rootDebtClosure)) reject('rootDebtClosure must be an object');
  if (!Array.isArray(config.ownership)) reject('ownership must be an array');
  if (!valid) return false;

  const debtSections = [
    { entries: Object.entries(config.legacyAppShell.files), full: true },
    { entries: Object.entries(config.legacyAppShell.closure), full: false },
    { entries: Object.entries(config.rootDebt), full: true },
    { entries: Object.entries(config.rootDebtClosure), full: false },
  ];
  for (const section of debtSections) {
    for (const [path, debt] of section.entries) {
      const requiredPrefix = section.full ? 'src/renderer/' : 'src/';
      if (!path.startsWith(requiredPrefix) || path.includes('..') || path.includes('\\')) {
        reject(`${path}: debt path must be a normalized ${section.full ? 'renderer' : 'Desktop'} source path`);
      }
      if (!isRecord(debt)) {
        reject(`${path}: debt entry must be an object`);
        continue;
      }
      if (section.full) {
        for (const metric of ['importDeclarations', 'importSpecifiers', 'nonTriviaTokens']) {
          if (!Number.isInteger(debt[metric]) || debt[metric] < 0) reject(`${path}: ${metric} must be a non-negative integer`);
        }
      }
      if (!Number.isInteger(debt.unresolvedDependencies) || debt.unresolvedDependencies < 0) {
        reject(`${path}: unresolvedDependencies must be a non-negative integer`);
      }
      for (const metric of ['bridgePaths', 'dependencyPaths', 'environmentCapabilities', 'hookCalls', 'lifecycleMethods']) {
        if (!validateCountMap(debt[metric])) reject(`${path}: ${metric} must be a non-negative count map`);
      }
      if (!isSortedUniqueStrings(debt.actionFactories)) reject(`${path}: actionFactories must be sorted unique strings`);
    }
  }

  const capabilities = new Set();
  const targetZone = /^(?:application(?:\/[a-z0-9-]+)*|bootstrap|composition|features\/[a-z0-9-]+|shell|split-by-capability|testing)$/u;
  for (const owner of config.ownership) {
    if (!isRecord(owner)) {
      reject('ownership entries must be objects');
      continue;
    }
    if (typeof owner.capability !== 'string' || owner.capability.length === 0) reject('ownership capability must be non-empty');
    if (capabilities.has(owner.capability)) reject(`duplicate ownership capability ${owner.capability}`);
    capabilities.add(owner.capability);
    if (typeof owner.targetZone !== 'string' || !targetZone.test(owner.targetZone)) {
      reject(`${owner.capability}: unsupported targetZone ${String(owner.targetZone)}`);
    }
    if (!isSortedUniqueStrings(owner.legacyPaths)) {
      reject(`${owner.capability}: legacyPaths must be sorted unique strings`);
    }
  }
  const controllerOwnerKeys = new Set();
  let previousControllerOwnerKey = '';
  for (const owner of controllerOwnersOf(config)) {
    if (!isRecord(owner)) {
      reject('controllerOwners entries must be objects');
      continue;
    }
    const key = controllerOwnerKey(owner);
    if (controllerOwnerKeys.has(key)) reject(`duplicate controller owner ${key}`);
    if (key.localeCompare(previousControllerOwnerKey) < 0) {
      reject('controllerOwners must be sorted by implementation and symbol');
    }
    controllerOwnerKeys.add(key);
    previousControllerOwnerKey = key;
    for (const field of ['symbol', 'ownerSymbol']) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(owner[field] ?? '')) {
        reject(`${key}: ${field} must be a JavaScript identifier`);
      }
    }
    for (const field of ['implementation', 'owner']) {
      const path = owner[field];
      if (
        typeof path !== 'string' ||
        !path.startsWith('src/renderer/features/') ||
        path.includes('..') ||
        path.includes('\\') ||
        !SOURCE_FILE.test(path)
      ) {
        reject(`${key}: ${field} must be a normalized feature source path`);
      }
    }
    const implementationFeature = owner.implementation?.match(
      /^src\/renderer\/features\/([^/]+)\//u,
    )?.[1];
    const ownerFeature = owner.owner?.match(
      /^src\/renderer\/features\/([^/]+)\//u,
    )?.[1];
    if (!implementationFeature || implementationFeature !== ownerFeature) {
      reject(`${key}: implementation and owner must belong to the same feature`);
    }
    if (
      isTestConsumer(owner.owner ?? '') ||
      /\/(?:index|testing)\.(?:(?:c|m)?(?:js|ts)x?)$/u.test(owner.owner ?? '')
    ) {
      reject(`${key}: owner must be a production feature implementation file`);
    }
    if (![0, 1].includes(owner.count)) {
      reject(`${key}: count must be 0 or 1`);
    }
  }
  return valid;
}

function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (['comments', 'end', 'errors', 'extra', 'loc', 'start', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.type === 'string') children.push(item);
      }
      continue;
    }
    if (value && typeof value === 'object' && typeof value.type === 'string') children.push(value);
  }
  return children;
}

function isMemberExpression(node) {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression';
}

function memberName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'StringLiteral') return node.value;
  return undefined;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    ['ParenthesizedExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TypeCastExpression'].includes(
      current.type,
    )
  ) {
    current = current.expression;
  }
  return current;
}

function memberPropertyName(node) {
  if (!isMemberExpression(node)) return undefined;
  const property = unwrapExpression(node.property);
  if (!node.computed && property?.type === 'Identifier') return property.name;
  return staticString(property);
}

function isWindowExpression(node, windowAliases = new Set(['globalThis', 'window'])) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Identifier' && windowAliases.has(expression.name)) return true;
  return (
    isMemberExpression(expression) &&
    unwrapExpression(expression.object)?.type === 'Identifier' &&
    windowAliases.has(unwrapExpression(expression.object).name) &&
    memberPropertyName(expression) === 'window'
  );
}

function isWindowMaka(node, windowAliases) {
  const expression = unwrapExpression(node);
  return (
    isMemberExpression(expression) &&
    isWindowExpression(expression.object, windowAliases) &&
    memberPropertyName(expression) === 'maka'
  );
}

function hookCallNames(
  node,
  hookAliases,
  hookNamespaces,
  reactNamespaces,
  parents,
  hookBindings,
) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Identifier') {
    const binding = lexicalBindingIdentifier(expression, expression.name, parents);
    return binding
      ? hookBindings.hookAliasBindings.get(binding)
      : hookAliases.get(expression.name);
  }
  if (
    isMemberExpression(expression) &&
    unwrapExpression(expression.object)?.type === 'Identifier'
  ) {
    const name = memberPropertyName(expression);
    const namespaceNode = unwrapExpression(expression.object);
    const namespace = namespaceNode.name;
    const binding = lexicalBindingIdentifier(namespaceNode, namespace, parents);
    const reactNamespace = binding
      ? hookBindings.reactNamespaceBindings.has(binding)
      : reactNamespaces.has(namespace);
    const hookNamespace = binding
      ? hookBindings.hookNamespaceBindings.has(binding)
      : hookNamespaces.has(namespace);
    if (reactNamespace && name && STATEFUL_HOOKS.has(name)) return new Set([name]);
    if (hookNamespace && name && /^use[A-Z0-9]/u.test(name)) return new Set([name]);
  }
  return undefined;
}

function addHookNames(aliases, key, names) {
  if (!names) return false;
  let known = aliases.get(key);
  if (!known) {
    known = new Set();
    aliases.set(key, known);
  }
  let changed = false;
  for (const name of names) {
    if (known.has(name)) continue;
    known.add(name);
    changed = true;
  }
  return changed;
}

function staticString(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left !== undefined && right !== undefined ? `${left}${right}` : undefined;
  }
  if (node?.type === 'TemplateLiteral') {
    let value = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      value += node.quasis[index]?.value.cooked ?? node.quasis[index]?.value.raw ?? '';
      if (index < node.expressions.length) {
        const expression = staticString(node.expressions[index]);
        if (expression === undefined) return undefined;
        value += expression;
      }
    }
    return value;
  }
  return undefined;
}

function environmentPath(
  node,
  windowAliases,
  environmentAliases = new Map(),
  parents = new WeakMap(),
) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Identifier') {
    if (environmentAliases.has(expression.name)) return environmentAliases.get(expression.name);
    if (windowAliases.has(expression.name)) return 'window';
    if (ENVIRONMENT_OBJECTS.has(expression.name) && !environmentIdentifierIsShadowed(expression, expression.name, parents)) {
      return expression.name;
    }
    return undefined;
  }
  if (!isMemberExpression(expression)) return undefined;
  const base = environmentPath(
    expression.object,
    windowAliases,
    environmentAliases,
    parents,
  );
  const property = memberPropertyName(expression);
  if (!base || !property) return undefined;
  return `${base}.${property}`;
}

function bridgePath(node, windowAliases, bridgeAliases = new Map()) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Identifier') return bridgeAliases.get(expression.name);
  if (isWindowMaka(expression, windowAliases)) return 'window.maka';
  if (!isMemberExpression(expression)) return undefined;
  const base = bridgePath(expression.object, windowAliases, bridgeAliases);
  const property = memberPropertyName(expression);
  if (!base || !property) return undefined;
  return `${base}.${property}`;
}

function typeOnlySourceDependency(node) {
  if (node.type === 'ImportDeclaration') {
    return (
      node.importKind === 'type' ||
      (node.specifiers.length > 0 &&
        node.specifiers.every((specifier) => specifier.importKind === 'type'))
    );
  }
  if (node.type === 'ExportNamedDeclaration') {
    return (
      node.exportKind === 'type' ||
      (node.specifiers.length > 0 &&
        node.specifiers.every((specifier) => specifier.exportKind === 'type'))
    );
  }
  if (node.type === 'ExportAllDeclaration') return node.exportKind === 'type';
  if (node.type === 'TSImportType') return true;
  return false;
}

function sourceDependency(node) {
  if (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration') &&
    staticString(node.source) !== undefined
  ) {
    return staticString(node.source);
  }
  if (node.type === 'ImportExpression' && staticString(node.source) !== undefined) {
    return staticString(node.source);
  }
  if (
    node.type === 'TSImportEqualsDeclaration' &&
    node.moduleReference?.type === 'TSExternalModuleReference' &&
    staticString(node.moduleReference.expression) !== undefined
  ) {
    return staticString(node.moduleReference.expression);
  }
  if (node.type === 'TSImportType' && staticString(node.argument) !== undefined) {
    return staticString(node.argument);
  }
  if (
    (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
    staticString(node.arguments?.[0]) !== undefined &&
    (node.callee?.type === 'Import' ||
      (node.callee?.type === 'Identifier' && node.callee.name === 'require'))
  ) {
    return staticString(node.arguments[0]);
  }
  return undefined;
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'AssignmentPattern') return bindingNames(pattern.left);
  if (pattern.type === 'RestElement') return bindingNames(pattern.argument);
  if (pattern.type === 'TSParameterProperty') return bindingNames(pattern.parameter);
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap((element) => bindingNames(element));
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) =>
      property.type === 'RestElement' ? bindingNames(property.argument) : bindingNames(property.value),
    );
  }
  return [];
}

function buildParentMap(root) {
  const parents = new WeakMap();
  function visit(node) {
    for (const child of childNodes(node)) {
      parents.set(child, node);
      visit(child);
    }
  }
  visit(root);
  return parents;
}

function statementBindings(statement) {
  const declaration =
    statement?.type === 'ExportNamedDeclaration' || statement?.type === 'ExportDefaultDeclaration'
      ? statement.declaration
      : statement;
  if (!declaration) return [];
  if (declaration.type === 'ImportDeclaration') return declaration.specifiers.map((specifier) => specifier.local.name);
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((item) => bindingNames(item.id));
  }
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    return bindingNames(declaration.id);
  }
  return [];
}

function bindingIdentifier(pattern, name) {
  if (!pattern) return undefined;
  if (pattern.type === 'Identifier') return pattern.name === name ? pattern : undefined;
  if (pattern.type === 'AssignmentPattern') return bindingIdentifier(pattern.left, name);
  if (pattern.type === 'RestElement') return bindingIdentifier(pattern.argument, name);
  if (pattern.type === 'TSParameterProperty') return bindingIdentifier(pattern.parameter, name);
  if (pattern.type === 'ArrayPattern') {
    return pattern.elements
      .map((element) => bindingIdentifier(element, name))
      .find(Boolean);
  }
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties
      .map((property) =>
        property.type === 'RestElement'
          ? bindingIdentifier(property.argument, name)
          : bindingIdentifier(property.value, name),
      )
      .find(Boolean);
  }
  return undefined;
}

function statementBindingIdentifier(statement, name, includeVar = true) {
  const declaration =
    statement?.type === 'ExportNamedDeclaration' || statement?.type === 'ExportDefaultDeclaration'
      ? statement.declaration
      : statement;
  if (!declaration) return undefined;
  if (declaration.type === 'ImportDeclaration') {
    return declaration.specifiers
      .map((specifier) => specifier.local)
      .find((local) => local.name === name);
  }
  if (declaration.type === 'VariableDeclaration') {
    if (!includeVar && declaration.kind === 'var') return undefined;
    return declaration.declarations
      .map((item) => bindingIdentifier(item.id, name))
      .find(Boolean);
  }
  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    return bindingIdentifier(declaration.id, name);
  }
  return undefined;
}

function hoistedVarBindingIdentifier(root, name) {
  let found;
  function visit(node, isRoot = false) {
    if (!node || found) return;
    if (
      !isRoot &&
      [
        'ArrowFunctionExpression',
        'ClassDeclaration',
        'ClassExpression',
        'ClassMethod',
        'ClassPrivateMethod',
        'FunctionDeclaration',
        'FunctionExpression',
        'ObjectMethod',
        'StaticBlock',
      ].includes(node.type)
    ) {
      return;
    }
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      found = node.declarations
        .map((item) => bindingIdentifier(item.id, name))
        .find(Boolean);
      if (found) return;
    }
    for (const child of childNodes(node)) visit(child);
  }
  visit(root, true);
  return found;
}

function lexicalBindingIdentifier(node, name, parents) {
  let current = parents.get(node);
  while (current) {
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'ObjectMethod' ||
      current.type === 'ClassMethod' ||
      current.type === 'ClassPrivateMethod'
    ) {
      const parameter = current.params
        .map((item) => bindingIdentifier(item, name))
        .find(Boolean);
      if (parameter) return parameter;
      if (current.type !== 'ArrowFunctionExpression' && !current.type.endsWith('Method')) {
        const functionName = bindingIdentifier(current.id, name);
        if (functionName) return functionName;
      }
      const hoisted = hoistedVarBindingIdentifier(current.body, name);
      if (hoisted) return hoisted;
    }
    if (current.type === 'CatchClause') {
      const caught = bindingIdentifier(current.param, name);
      if (caught) return caught;
    }
    if (current.type === 'Program' || current.type === 'BlockStatement') {
      const declared = current.body
        .map((statement) => statementBindingIdentifier(statement, name, false))
        .find(Boolean);
      if (declared) return declared;
      if (current.type === 'Program') {
        const hoisted = hoistedVarBindingIdentifier(current, name);
        if (hoisted) return hoisted;
      }
    }
    if (
      current.type === 'ForStatement' &&
      current.init?.type === 'VariableDeclaration' &&
      current.init.kind !== 'var'
    ) {
      const declared = statementBindingIdentifier(current.init, name, false);
      if (declared) return declared;
    }
    if (
      (current.type === 'ForInStatement' || current.type === 'ForOfStatement') &&
      current.left?.type === 'VariableDeclaration' &&
      current.left.kind !== 'var'
    ) {
      const declared = statementBindingIdentifier(current.left, name, false);
      if (declared) return declared;
    }
    current = parents.get(current);
  }
  return undefined;
}

function environmentIdentifierIsShadowed(node, name, parents) {
  let current = parents.get(node);
  while (current) {
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'ObjectMethod' ||
      current.type === 'ClassMethod' ||
      current.type === 'ClassPrivateMethod'
    ) {
      if (
        current.type !== 'ArrowFunctionExpression' &&
        !current.type.endsWith('Method') &&
        bindingNames(current.id).includes(name)
      ) {
        return true;
      }
      if (current.params.some((parameter) => bindingNames(parameter).includes(name))) return true;
    }
    if (current.type === 'CatchClause' && bindingNames(current.param).includes(name)) return true;
    if (current.type === 'Program' || current.type === 'BlockStatement') {
      if (current.body.some((statement) => statementBindings(statement).includes(name))) return true;
    }
    if (
      current.type === 'ForStatement' &&
      current.init?.type === 'VariableDeclaration' &&
      statementBindings(current.init).includes(name)
    ) {
      return true;
    }
    if (
      (current.type === 'ForInStatement' || current.type === 'ForOfStatement') &&
      current.left?.type === 'VariableDeclaration' &&
      statementBindings(current.left).includes(name)
    ) {
      return true;
    }
    current = parents.get(current);
  }
  return false;
}

const NAMED_KEY_OWNERS = new Set([
  'ClassMethod',
  'ClassPrivateMethod',
  'ClassPrivateProperty',
  'ClassProperty',
  'ObjectMethod',
  'ObjectProperty',
  'PropertyDefinition',
  'TSMethodSignature',
  'TSPropertySignature',
]);
// TS wrapper nodes whose descendants still execute at runtime; every other
// TS-prefixed ancestor puts an identifier in erased type space.
const TS_RUNTIME_NODES = new Set([
  'TSAsExpression',
  'TSDeclareFunction',
  'TSDeclareMethod',
  'TSEnumDeclaration',
  'TSEnumMember',
  'TSExportAssignment',
  'TSExternalModuleReference',
  'TSImportEqualsDeclaration',
  'TSInstantiationExpression',
  'TSModuleBlock',
  'TSModuleDeclaration',
  'TSNonNullExpression',
  'TSParameterProperty',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

function isValueReferencePosition(node, parent, parents) {
  if (parent) {
    if (NAMED_KEY_OWNERS.has(parent.type) && parent.key === node && !parent.computed) return false;
    if (isMemberExpression(parent) && parent.property === node && !parent.computed) return false;
    if (
      ['BreakStatement', 'ContinueStatement', 'LabeledStatement'].includes(parent.type) &&
      parent.label === node
    ) {
      return false;
    }
  }
  for (let current = parent; current && current.type !== 'Program'; current = parents.get(current)) {
    if (current.type.startsWith('TS') && !TS_RUNTIME_NODES.has(current.type)) return false;
  }
  return true;
}

function collectAliases(program, parents) {
  const hookAliases = new Map();
  const hookAliasBindings = new Map();
  const hookNamespaces = new Set();
  const hookNamespaceBindings = new WeakSet();
  const reactComponentBases = new Set();
  const reactNamespaces = new Set();
  const reactNamespaceBindings = new WeakSet();
  const hookBindings = {
    hookAliasBindings,
    hookNamespaceBindings,
    reactNamespaceBindings,
  };
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const isReact = statement.source.value === 'react';
    for (const specifier of statement.specifiers) {
      if (isReact && (specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier')) {
        reactNamespaces.add(specifier.local.name);
        reactNamespaceBindings.add(specifier.local);
      } else if (isReact && specifier.type === 'ImportSpecifier') {
        const imported = memberName(specifier.imported);
        if (imported && STATEFUL_HOOKS.has(imported)) {
          addHookNames(hookAliases, specifier.local.name, [imported]);
          addHookNames(hookAliasBindings, specifier.local, [imported]);
        }
        if (imported === 'Component' || imported === 'PureComponent') reactComponentBases.add(specifier.local.name);
      } else if (!isReact) {
        const imported = specifier.type === 'ImportSpecifier' ? memberName(specifier.imported) : specifier.local.name;
        if (imported && /^use[A-Z0-9]/u.test(imported)) {
          addHookNames(hookAliases, specifier.local.name, [imported]);
          addHookNames(hookAliasBindings, specifier.local, [imported]);
        }
        if (specifier.type === 'ImportNamespaceSpecifier') {
          hookNamespaces.add(specifier.local.name);
          hookNamespaceBindings.add(specifier.local);
        }
      }
    }
  }

  const windowAliases = new Set(['globalThis', 'self', 'window']);
  const bridgeAliases = new Map();
  const environmentAliases = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    const addAlias = (aliases, name, path) => {
      if (!path || aliases.has(name)) return;
      aliases.set(name, path);
      changed = true;
    };
    function visit(node) {
      if (
        node.type === 'ClassDeclaration' &&
        node.id?.type === 'Identifier' &&
        isReactComponentClass(node, reactComponentBases, reactNamespaces) &&
        !reactComponentBases.has(node.id.name)
      ) {
        reactComponentBases.add(node.id.name);
        changed = true;
      }
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
        const declaredBinding =
          lexicalBindingIdentifier(node.id, node.id.name, parents) ?? node.id;
        const init = unwrapExpression(node.init);
        const initBinding =
          init?.type === 'Identifier'
            ? lexicalBindingIdentifier(init, init.name, parents)
            : undefined;
        const initIsReactNamespace =
          init?.type === 'Identifier' &&
          (initBinding
            ? reactNamespaceBindings.has(initBinding)
            : reactNamespaces.has(init.name));
        const initIsHookNamespace =
          init?.type === 'Identifier' &&
          (initBinding
            ? hookNamespaceBindings.has(initBinding)
            : hookNamespaces.has(init.name));
        if (initIsReactNamespace && !reactNamespaceBindings.has(declaredBinding)) {
          reactNamespaces.add(node.id.name);
          reactNamespaceBindings.add(declaredBinding);
          changed = true;
        }
        if (initIsHookNamespace && !hookNamespaceBindings.has(declaredBinding)) {
          hookNamespaces.add(node.id.name);
          hookNamespaceBindings.add(declaredBinding);
          changed = true;
        }
        if (isWindowExpression(node.init, windowAliases) && !windowAliases.has(node.id.name)) {
          windowAliases.add(node.id.name);
          changed = true;
        }
        addAlias(bridgeAliases, node.id.name, bridgePath(node.init, windowAliases, bridgeAliases));
        const environment = environmentPath(
          node.init,
          windowAliases,
          environmentAliases,
          parents,
        );
        if (environment && !environment.startsWith('window.maka')) {
          addAlias(environmentAliases, node.id.name, environment);
        }
        if (
          node.init?.type === 'Identifier' &&
          ENVIRONMENT_CALLS.has(node.init.name) &&
          !environmentIdentifierIsShadowed(node.init, node.init.name, parents)
        ) {
          addAlias(environmentAliases, node.id.name, node.init.name);
        }
        const hooks = hookCallNames(
          node.init,
          hookAliases,
          hookNamespaces,
          reactNamespaces,
          parents,
          hookBindings,
        );
        const nameChanged = addHookNames(hookAliases, node.id.name, hooks);
        const bindingChanged = addHookNames(
          hookAliasBindings,
          declaredBinding,
          hooks,
        );
        if (nameChanged || bindingChanged) {
          changed = true;
        }
      }
      if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern') {
        const bridgeBase = bridgePath(node.init, windowAliases, bridgeAliases);
        const environmentBase = environmentPath(
          node.init,
          windowAliases,
          environmentAliases,
          parents,
        );
        for (const property of node.id.properties) {
          if (property.type !== 'ObjectProperty' || property.computed || property.value?.type !== 'Identifier') continue;
          const propertyName = memberName(property.key);
          if (!propertyName) continue;
          if (bridgeBase) addAlias(bridgeAliases, property.value.name, `${bridgeBase}.${propertyName}`);
          if (isWindowExpression(node.init, windowAliases) && propertyName === 'maka') {
            addAlias(bridgeAliases, property.value.name, 'window.maka');
          }
          if (environmentBase && !environmentBase.startsWith('window.maka')) {
            addAlias(environmentAliases, property.value.name, `${environmentBase}.${propertyName}`);
          }
        }
      }
      if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
        const right = unwrapExpression(node.right);
        const rightBinding =
          right?.type === 'Identifier'
            ? lexicalBindingIdentifier(right, right.name, parents)
            : undefined;
        const leftBinding = lexicalBindingIdentifier(node.left, node.left.name, parents);
        const rightIsReactNamespace =
          right?.type === 'Identifier' &&
          (rightBinding
            ? reactNamespaceBindings.has(rightBinding)
            : reactNamespaces.has(right.name));
        const rightIsHookNamespace =
          right?.type === 'Identifier' &&
          (rightBinding
            ? hookNamespaceBindings.has(rightBinding)
            : hookNamespaces.has(right.name));
        if (
          rightIsReactNamespace &&
          (leftBinding
            ? !reactNamespaceBindings.has(leftBinding)
            : !reactNamespaces.has(node.left.name))
        ) {
          reactNamespaces.add(node.left.name);
          if (leftBinding) reactNamespaceBindings.add(leftBinding);
          changed = true;
        }
        if (
          rightIsHookNamespace &&
          (leftBinding
            ? !hookNamespaceBindings.has(leftBinding)
            : !hookNamespaces.has(node.left.name))
        ) {
          hookNamespaces.add(node.left.name);
          if (leftBinding) hookNamespaceBindings.add(leftBinding);
          changed = true;
        }
        addAlias(bridgeAliases, node.left.name, bridgePath(node.right, windowAliases, bridgeAliases));
        const environment = environmentPath(
          node.right,
          windowAliases,
          environmentAliases,
          parents,
        );
        if (environment && !environment.startsWith('window.maka')) {
          addAlias(environmentAliases, node.left.name, environment);
        }
        if (
          node.right?.type === 'Identifier' &&
          ENVIRONMENT_CALLS.has(node.right.name) &&
          !environmentIdentifierIsShadowed(node.right, node.right.name, parents)
        ) {
          addAlias(environmentAliases, node.left.name, node.right.name);
        }
        const hooks = hookCallNames(
          node.right,
          hookAliases,
          hookNamespaces,
          reactNamespaces,
          parents,
          hookBindings,
        );
        const nameChanged = addHookNames(hookAliases, node.left.name, hooks);
        const bindingChanged = leftBinding
          ? addHookNames(hookAliasBindings, leftBinding, hooks)
          : false;
        if (nameChanged || bindingChanged) {
          changed = true;
        }
      }
      if (
        node.type === 'VariableDeclarator' &&
        node.id?.type === 'ObjectPattern' &&
        unwrapExpression(node.init)?.type === 'Identifier'
      ) {
        const namespaceNode = unwrapExpression(node.init);
        const namespace = namespaceNode.name;
        const namespaceBinding = lexicalBindingIdentifier(
          namespaceNode,
          namespace,
          parents,
        );
        const reactNamespace = namespaceBinding
          ? reactNamespaceBindings.has(namespaceBinding)
          : reactNamespaces.has(namespace);
        const hookNamespace = namespaceBinding
          ? hookNamespaceBindings.has(namespaceBinding)
          : hookNamespaces.has(namespace);
        if (reactNamespace || hookNamespace) {
          for (const property of node.id.properties) {
            if (property.type !== 'ObjectProperty' || property.computed) continue;
            const imported = memberName(property.key);
            const recognized = reactNamespace
              ? imported && STATEFUL_HOOKS.has(imported)
              : imported && /^use[A-Z0-9]/u.test(imported);
            const local =
              property.value?.type === 'Identifier'
                ? property.value
                : property.value?.type === 'AssignmentPattern' &&
                    property.value.left?.type === 'Identifier'
                  ? property.value.left
                  : undefined;
            if (recognized && local) {
              const localBinding =
                lexicalBindingIdentifier(local, local.name, parents) ?? local;
              const nameChanged = addHookNames(hookAliases, local.name, [imported]);
              const bindingChanged = addHookNames(
                hookAliasBindings,
                localBinding,
                [imported],
              );
              if (nameChanged || bindingChanged) {
                changed = true;
              }
            }
          }
        }
      }
      for (const child of childNodes(node)) visit(child);
    }
    visit(program);
  }
  return {
    bridgeAliases,
    environmentAliases,
    hookAliases,
    hookBindings,
    hookNamespaces,
    reactComponentBases,
    reactNamespaces,
    windowAliases,
  };
}

function isReactComponentClass(node, reactComponentBases, reactNamespaces) {
  if (node?.type !== 'ClassDeclaration' && node?.type !== 'ClassExpression') return false;
  const superClass = unwrapExpression(node.superClass);
  if (superClass?.type === 'Identifier') return reactComponentBases.has(superClass.name);
  return (
    isMemberExpression(superClass) &&
    unwrapExpression(superClass.object)?.type === 'Identifier' &&
    reactNamespaces.has(unwrapExpression(superClass.object).name) &&
    ['Component', 'PureComponent'].includes(memberPropertyName(superClass))
  );
}

function enclosingClass(node, parents) {
  let current = parents.get(node);
  while (current) {
    if (current.type === 'ClassDeclaration' || current.type === 'ClassExpression') return current;
    current = parents.get(current);
  }
  return undefined;
}

function enclosingFunctionName(node, parents) {
  let current = parents.get(node);
  while (current) {
    if (current.type === 'FunctionDeclaration') return current.id?.name;
    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      const owner = parents.get(current);
      if (owner?.type === 'VariableDeclarator' && owner.id?.type === 'Identifier') {
        return owner.id.name;
      }
      if (owner?.type === 'ObjectProperty') return memberName(owner.key);
    }
    if (
      current.type === 'ObjectMethod' ||
      current.type === 'ClassMethod' ||
      current.type === 'ClassPrivateMethod'
    ) {
      return memberName(current.key);
    }
    current = parents.get(current);
  }
  return undefined;
}

function analyzeModuleImportBindingUsages(program, bindings, parents) {
  const bindingByName = new Map(
    bindings.map((binding, index) => [binding.name, { binding, index }]),
  );
  const usages = bindings.map(() => ({
    directCalls: 0,
    references: 0,
    directCallOwners: [],
    memberCalls: {},
    memberReferences: {},
  }));

  function visit(node) {
    const imported =
      node.type === 'Identifier' ? bindingByName.get(node.name) : undefined;
    if (
      imported &&
      node !== imported.binding &&
      parents.get(node)?.type !== 'ImportSpecifier' &&
      lexicalBindingIdentifier(node, imported.binding.name, parents) ===
        imported.binding
    ) {
      const usage = usages[imported.index];
      const parent = parents.get(node);
      if (
        (parent?.type === 'CallExpression' ||
          parent?.type === 'OptionalCallExpression') &&
        unwrapExpression(parent.callee) === node
      ) {
        usage.directCalls += 1;
        usage.directCallOwners.push(enclosingFunctionName(parent, parents));
      } else if (
        isMemberExpression(parent) &&
        unwrapExpression(parent.object) === node
      ) {
        const property = memberPropertyName(parent);
        const owner = parents.get(parent);
        if (
          property &&
          (owner?.type === 'CallExpression' ||
            owner?.type === 'OptionalCallExpression') &&
          unwrapExpression(owner.callee) === parent
        ) {
          usage.memberCalls[property] =
            (usage.memberCalls[property] ?? 0) + 1;
        } else if (property) {
          usage.memberReferences[property] =
            (usage.memberReferences[property] ?? 0) + 1;
        } else {
          usage.references += 1;
        }
      } else {
        usage.references += 1;
      }
    }
    for (const child of childNodes(node)) visit(child);
  }

  visit(program);
  return usages.map((usage) => ({
    ...usage,
    memberCalls: sortedObject(usage.memberCalls),
    memberReferences: sortedObject(usage.memberReferences),
  }));
}

export function analyzeRendererSource(source, file = 'fixture.ts') {
  const typedSource = /\.(?:(?:c|m)?ts|tsx)$/u.test(file);
  const jsxSource = /\.(?:jsx|tsx)$/u.test(file);
  const ast = parse(source, {
    createImportExpressions: true,
    errorRecovery: false,
    plugins: PARSER_PLUGINS.filter((plugin) => (plugin === 'typescript' ? typedSource : plugin === 'jsx' ? jsxSource : true)),
    sourceFilename: file,
    sourceType: 'module',
    tokens: true,
  });
  const parents = buildParentMap(ast.program);
  const {
    bridgeAliases,
    environmentAliases,
    hookAliases,
    hookBindings,
    hookNamespaces,
    reactComponentBases,
    reactNamespaces,
    windowAliases,
  } = collectAliases(ast.program, parents);
  const bridgePaths = {};
  const environmentCapabilities = {};
  const hookCalls = {};
  const lifecycleMethods = {};
  const actionFactories = [];
  const dependencies = [];
  const dependencyPaths = {};
  const moduleImports = [];
  const moduleImportBindings = [];
  const moduleLoads = [];
  const moduleDirectExportBindings = [];
  const moduleLocalExports = [];
  const moduleReexports = [];
  let importDeclarations = 0;
  let importSpecifiers = 0;
  let unresolvedDependencies = 0;

  function recordBridgePath(path) {
    bridgePaths[path] = (bridgePaths[path] ?? 0) + 1;
  }

  function recordEnvironmentCapability(path) {
    environmentCapabilities[path] = (environmentCapabilities[path] ?? 0) + 1;
  }

  function visit(node, parent) {
    if (node.type === 'ImportDeclaration' && !typeOnlySourceDependency(node)) {
      importDeclarations += 1;
      importSpecifiers += node.specifiers.filter((specifier) => specifier.importKind !== 'type').length;
      const source = staticString(node.source);
      if (source !== undefined && node.importKind !== 'type') {
        for (const specifier of node.specifiers) {
          if (specifier.importKind === 'type') continue;
          if (specifier.type === 'ImportSpecifier') {
            const entry = {
              source,
              kind: 'named',
              imported: memberName(specifier.imported),
              local: specifier.local.name,
            };
            moduleImports.push(entry);
            moduleImportBindings.push(specifier.local);
          } else if (specifier.type === 'ImportNamespaceSpecifier') {
            const entry = {
              source,
              kind: 'namespace',
              local: specifier.local.name,
            };
            moduleImports.push(entry);
            moduleImportBindings.push(specifier.local);
          } else if (specifier.type === 'ImportDefaultSpecifier') {
            const entry = {
              source,
              kind: 'default',
              local: specifier.local.name,
            };
            moduleImports.push(entry);
            moduleImportBindings.push(specifier.local);
          }
        }
        if (node.specifiers.length === 0) {
          moduleLoads.push({ source, kind: 'side-effect' });
        }
      }
    }
    if (node.type === 'ExportNamedDeclaration' && node.source == null) {
      const declaration = node.declaration;
      if (
        (declaration?.type === 'FunctionDeclaration' ||
          declaration?.type === 'ClassDeclaration') &&
        declaration.id?.name
      ) {
        const entry = {
          local: declaration.id.name,
          exported: declaration.id.name,
        };
        moduleLocalExports.push(entry);
        moduleDirectExportBindings.push({ ...entry, binding: declaration.id });
      } else if (declaration?.type === 'VariableDeclaration') {
        for (const item of declaration.declarations) {
          for (const name of bindingNames(item.id)) {
            const entry = { local: name, exported: name };
            moduleLocalExports.push(entry);
            moduleDirectExportBindings.push({
              ...entry,
              binding: bindingIdentifier(item.id, name),
            });
          }
        }
      }
      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ExportSpecifier' || specifier.exportKind === 'type') {
          continue;
        }
        moduleLocalExports.push({
          local: memberName(specifier.local),
          exported: memberName(specifier.exported),
        });
      }
    }
    if (node.type === 'TSImportEqualsDeclaration') {
      importDeclarations += 1;
      importSpecifiers += 1;
    }
    if (
      (node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.exportKind !== 'type'
    ) {
      const source = staticString(node.source);
      if (source !== undefined) {
        if (node.type === 'ExportAllDeclaration') {
          moduleReexports.push({ source, kind: 'all' });
        } else {
          for (const specifier of node.specifiers) {
            if (specifier.exportKind === 'type') continue;
            if (specifier.type === 'ExportSpecifier') {
              moduleReexports.push({
                source,
                kind: 'named',
                imported: memberName(specifier.local),
                exported: memberName(specifier.exported),
              });
            } else if (specifier.type === 'ExportNamespaceSpecifier') {
              moduleReexports.push({
                source,
                kind: 'namespace',
                exported: memberName(specifier.exported),
              });
            }
          }
        }
      }
    }
    const dependency = sourceDependency(node);
    if (dependency !== undefined) {
      dependencies.push(dependency);
      // Type-only imports are erased at compile time: they stay in `dependencies`
      // for closure reachability but record no debt.
      if (!typeOnlySourceDependency(node)) {
        dependencyPaths[dependency] = (dependencyPaths[dependency] ?? 0) + 1;
      }
      if (node.type === 'ImportExpression') {
        moduleLoads.push({ source: dependency, kind: 'dynamic-import' });
      } else if (node.type === 'TSImportEqualsDeclaration' && !node.isTypeOnly) {
        moduleLoads.push({ source: dependency, kind: 'import-equals' });
      } else if (
        (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
        (node.callee?.type === 'Import' ||
          (node.callee?.type === 'Identifier' && node.callee.name === 'require'))
      ) {
        moduleLoads.push({
          source: dependency,
          kind: node.callee.type === 'Import' ? 'dynamic-import' : 'require',
        });
      }
    }
    if (
      (node.type === 'ImportExpression' && staticString(node.source) === undefined) ||
      ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
        (node.callee?.type === 'Import' ||
          (node.callee?.type === 'Identifier' && node.callee.name === 'require')) &&
        staticString(node.arguments?.[0]) === undefined) ||
      ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
        isMemberExpression(node.callee) &&
        unwrapExpression(node.callee.object)?.type === 'MetaProperty' &&
        unwrapExpression(node.callee.object).meta?.name === 'import' &&
        unwrapExpression(node.callee.object).property?.name === 'meta' &&
        ['glob', 'globEager'].includes(memberPropertyName(node.callee)))
    ) {
      unresolvedDependencies += 1;
    }

    const directEnvironmentPath = environmentPath(
      node,
      windowAliases,
      environmentAliases,
      parents,
    );
    if (
      directEnvironmentPath &&
      !directEnvironmentPath.startsWith('window.maka') &&
      !(isMemberExpression(parent) && unwrapExpression(parent.object) === node) &&
      isValueReferencePosition(node, parent, parents)
    ) {
      recordEnvironmentCapability(directEnvironmentPath);
    }

    if (isMemberExpression(node) && memberPropertyName(node) === undefined) {
      const dynamicBridgeBase = bridgePath(node.object, windowAliases, bridgeAliases);
      if (dynamicBridgeBase) recordBridgePath(`${dynamicBridgeBase}.*`);
      const dynamicEnvironmentBase = environmentPath(
        node.object,
        windowAliases,
        environmentAliases,
        parents,
      );
      if (dynamicEnvironmentBase && !dynamicEnvironmentBase.startsWith('window.maka')) {
        recordEnvironmentCapability(`${dynamicEnvironmentBase}.*`);
      }
    }

    const directBridgePath = bridgePath(node, windowAliases, bridgeAliases);
    if (
      directBridgePath &&
      !(isMemberExpression(parent) && unwrapExpression(parent.object) === node) &&
      !(node.type === 'Identifier' && parent?.type === 'VariableDeclarator' && parent.id === node)
    ) {
      recordBridgePath(directBridgePath);
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'ObjectPattern' &&
      isWindowExpression(node.init, windowAliases)
    ) {
      for (const property of node.id.properties) {
        if (property.type === 'ObjectProperty' && !property.computed && memberName(property.key) === 'maka') {
          recordBridgePath('window.maka');
        }
      }
    }

    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const names = hookCallNames(
        node.callee,
        hookAliases,
        hookNamespaces,
        reactNamespaces,
        parents,
        hookBindings,
      );
      for (const name of names ?? []) {
        hookCalls[name] = (hookCalls[name] ?? 0) + 1;
      }
      const callee = unwrapExpression(node.callee);
      if (
        callee?.type === 'Identifier' &&
        ENVIRONMENT_CALLS.has(callee.name) &&
        !environmentIdentifierIsShadowed(callee, callee.name, parents)
      ) {
        recordEnvironmentCapability(callee.name);
      }
    }
    if (node.type === 'NewExpression') {
      const callee = unwrapExpression(node.callee);
      if (
        callee?.type === 'Identifier' &&
        ENVIRONMENT_CALLS.has(callee.name) &&
        !environmentIdentifierIsShadowed(callee, callee.name, parents)
      ) {
        recordEnvironmentCapability(callee.name);
      }
    }
    const ownerClass = enclosingClass(node, parents);
    const reactComponentOwner = isReactComponentClass(ownerClass, reactComponentBases, reactNamespaces);
    if (reactComponentOwner && (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod')) {
      const name = memberName(node.key);
      if (name && REACT_LIFECYCLE_METHODS.has(name)) {
        lifecycleMethods[name] = (lifecycleMethods[name] ?? 0) + 1;
      }
    }
    if (reactComponentOwner && ['ClassProperty', 'ClassPrivateProperty', 'PropertyDefinition'].includes(node.type)) {
      const name = memberName(node.key);
      if (name === 'state' || (name && REACT_LIFECYCLE_METHODS.has(name))) {
        lifecycleMethods[name] = (lifecycleMethods[name] ?? 0) + 1;
      }
    }
    if (
      reactComponentOwner &&
      isMemberExpression(node) &&
      unwrapExpression(node.object)?.type === 'ThisExpression' &&
      ['setState', 'state'].includes(memberPropertyName(node))
    ) {
      const name = memberPropertyName(node);
      lifecycleMethods[name] = (lifecycleMethods[name] ?? 0) + 1;
    }

    if (
      (node.type === 'FunctionDeclaration' || node.type === 'VariableDeclarator') &&
      node.id?.type === 'Identifier' &&
      node.id.name.startsWith('createAppShell')
    ) {
      actionFactories.push(node.id.name);
    }

    for (const child of childNodes(node)) {
      parents.set(child, node);
      visit(child, node);
    }
  }

  visit(ast.program, undefined);
  const moduleImportUsages = analyzeModuleImportBindingUsages(
    ast.program,
    moduleImportBindings,
    parents,
  );
  const moduleDirectExportUsages = analyzeModuleImportBindingUsages(
    ast.program,
    moduleDirectExportBindings.map((entry) => entry.binding),
    parents,
  );
  return {
    actionFactories: actionFactories.sort(),
    bridgePaths: sortedObject(bridgePaths),
    dependencies,
    dependencyPaths: sortedObject(dependencyPaths),
    environmentCapabilities: sortedObject(environmentCapabilities),
    hookCalls: sortedObject(hookCalls),
    importDeclarations,
    importSpecifiers,
    lifecycleMethods: sortedObject(lifecycleMethods),
    moduleImports: moduleImports.map((entry, index) => ({
      ...entry,
      ...moduleImportUsages[index],
    })),
    moduleDirectExports: moduleDirectExportBindings.map((entry, index) => ({
      local: entry.local,
      exported: entry.exported,
      ...moduleDirectExportUsages[index],
    })),
    moduleLoads,
    moduleLocalExports,
    moduleReexports,
    nonTriviaTokens: ast.tokens.length,
    unresolvedDependencies,
  };
}

function sourceFiles(root, { includeDeclarations = false } = {}) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, { includeDeclarations });
    return SOURCE_FILE.test(entry.name) && (includeDeclarations || !DECLARATION_FILE.test(entry.name)) ? [path] : [];
  });
}

function zoneFor(path) {
  const normalized = normalizePath(path).replace(SOURCE_EXTENSION, '');
  if (normalized.startsWith('src/main/')) return { kind: 'main' };
  if (normalized.startsWith('src/preload/')) return { kind: 'preload' };
  if (!normalized.startsWith('src/renderer/')) return { kind: 'external' };
  const feature = normalized.match(/^src\/renderer\/features\/([^/]+)(?:\/(.*))?$/u);
  if (feature) return { kind: 'feature', name: feature[1], subpath: feature[2] ?? '' };
  for (const kind of ['application', 'bootstrap', 'composition', 'shell']) {
    const prefix = `src/renderer/${kind}/`;
    if (normalized.startsWith(prefix)) return { kind, subpath: normalized.slice(prefix.length) };
  }
  if (normalized.startsWith('src/renderer/platform/desktop/')) return { kind: 'platform' };
  return { kind: 'legacy' };
}

function isRootClosureDebtSource(path) {
  return ['external', 'legacy', 'main', 'preload'].includes(zoneFor(path).kind);
}

function resolveDependency(desktopRoot, importer, dependency) {
  const normalizedDependency = dependency.split(/[?#]/u, 1)[0];
  let target;
  if (normalizedDependency.startsWith('.')) {
    target = resolve(dirname(importer), normalizedDependency);
  } else if (normalizedDependency.startsWith(DESKTOP_SELF_PREFIX)) {
    target = resolve(
      desktopRoot,
      normalizedDependency.slice(DESKTOP_SELF_PREFIX.length),
    );
  }
  else return undefined;
  const normalized = normalizePath(target);
  return normalized.replace(/\.(?:c|m)?(?:js|ts)x?$/u, '');
}

function sourceFileIndex(desktopRoot) {
  const index = new Map();
  const paths = sourceFiles(resolve(desktopRoot, 'src'), { includeDeclarations: true }).sort();
  for (const path of paths.filter((path) => !DECLARATION_FILE.test(path))) {
    const key = normalizePath(path).replace(SOURCE_EXTENSION, '');
    if (!index.has(key)) index.set(key, path);
  }
  for (const path of paths.filter((path) => DECLARATION_FILE.test(path))) {
    const key = normalizePath(path).replace(SOURCE_EXTENSION, '');
    index.set(key, path);
    const runtimeAlias = key.replace(/\.d$/u, '');
    if (!index.has(runtimeAlias)) index.set(runtimeAlias, path);
  }
  return index;
}

function resolveSourceFile(desktopRoot, importer, dependency, index) {
  const target = resolveDependency(desktopRoot, importer, dependency);
  if (!target) return undefined;
  return index.get(target) ?? index.get(`${target}/index`);
}

function isSourceLikeDependency(dependency) {
  const withoutQuery = dependency.split(/[?#]/u, 1)[0];
  const lastSegment = withoutQuery.split('/').at(-1) ?? '';
  return !lastSegment.includes('.') || SOURCE_EXTENSION.test(lastSegment);
}

function isAllowedLegacyGrowthPath(config, path) {
  return config.legacyGrowthDirectories.some((directory) => path.startsWith(`${directory}/`));
}

function capabilityDebtMetrics(analysis) {
  return {
    bridgePaths: analysis.bridgePaths,
    environmentCapabilities: analysis.environmentCapabilities,
    hookCalls: analysis.hookCalls,
    lifecycleMethods: analysis.lifecycleMethods,
    unresolvedDependencies: analysis.unresolvedDependencies,
    actionFactories: analysis.actionFactories,
    dependencyPaths: analysis.dependencyPaths,
  };
}

function debtMetrics(analysis) {
  return {
    importDeclarations: analysis.importDeclarations,
    ...capabilityDebtMetrics(analysis),
    importSpecifiers: analysis.importSpecifiers,
    nonTriviaTokens: analysis.nonTriviaTokens,
  };
}

function collectRootDependencyClosure(desktopRoot, rootPaths, violations = [], label = 'renderer root') {
  const index = sourceFileIndex(desktopRoot);
  const sourceRoot = normalizePath(resolve(desktopRoot, 'src'));
  const roots = new Set(rootPaths);
  const queue = rootPaths.map((path) => resolve(desktopRoot, path));
  const seen = new Set();
  const closure = new Set();

  while (queue.length > 0) {
    const file = queue.shift();
    const fileKey = normalizePath(file).replace(SOURCE_EXTENSION, '');
    if (seen.has(fileKey) || !existsSync(file)) continue;
    seen.add(fileKey);
    const fileRelative = normalizePath(relative(desktopRoot, file));
    let analysis;
    try {
      analysis = analyzeRendererSource(readFileSync(file, 'utf8'), fileRelative);
    } catch (error) {
      violations.push(`${fileRelative}: could not parse ${label} dependency closure source: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (analysis.unresolvedDependencies > 0) {
      violations.push(`${fileRelative}: ${label} closure contains a non-static import, require, or import.meta glob`);
    }
    for (const dependency of analysis.dependencies) {
      const unresolvedTarget = resolveDependency(desktopRoot, file, dependency);
      if (!unresolvedTarget) continue;
      const normalizedTarget = normalizePath(unresolvedTarget);
      if (normalizedTarget !== sourceRoot && !normalizedTarget.startsWith(`${sourceRoot}/`)) continue;
      const target = resolveSourceFile(desktopRoot, file, dependency, index);
      if (!target) {
        if (isSourceLikeDependency(dependency)) {
          violations.push(`${fileRelative}: ${label} closure dependency does not resolve to Desktop source: ${dependency}`);
        }
        continue;
      }
      const targetRelative = normalizePath(relative(desktopRoot, target));
      if (!seen.has(normalizePath(target).replace(SOURCE_EXTENSION, ''))) queue.push(target);
      if (isRootClosureDebtSource(targetRelative) && !DECLARATION_FILE.test(target) && !roots.has(targetRelative)) {
        closure.add(targetRelative);
      }
    }
  }
  return [...closure].sort();
}

function featureForAbsolutePath(desktopRoot, absolutePath) {
  const rendererFeatures = normalizePath(resolve(desktopRoot, 'src/renderer/features'));
  if (absolutePath !== rendererFeatures && !absolutePath.startsWith(`${rendererFeatures}/`)) return undefined;
  const rest = absolutePath.slice(rendererFeatures.length).replace(/^\//u, '');
  const [name, ...segments] = rest.split('/');
  return { name, subpath: segments.join('/') };
}

function isTestConsumer(path) {
  const normalized = normalizePath(path);
  return (
    normalized.includes('/__tests__/') ||
    normalized.includes('/e2e/') ||
    normalized.includes('/stories/') ||
    /\.(?:spec|stories|test)\.[^/]+$/u.test(normalized)
  );
}

function validateControllerOwners({
  desktopRoot,
  config,
  sourceAnalyses,
  violations,
}) {
  for (const contract of controllerOwnersOf(config)) {
    const key = controllerOwnerKey(contract);
    const featureName = contract.implementation.match(
      /^src\/renderer\/features\/([^/]+)\//u,
    )?.[1];
    const featureRoot = `src/renderer/features/${featureName}`;
    const publicEntry = `${featureRoot}/index.ts`;
    const testingEntry = `${featureRoot}/testing.ts`;
    const implementationTarget = normalizePath(
      resolve(desktopRoot, contract.implementation),
    ).replace(SOURCE_EXTENSION, '');
    const ownerTarget = normalizePath(resolve(desktopRoot, contract.owner)).replace(
      SOURCE_EXTENSION,
      '',
    );
    const publicEntryTargets = new Set(
      [featureRoot, publicEntry].map((path) =>
        normalizePath(resolve(desktopRoot, path)).replace(SOURCE_EXTENSION, ''),
      ),
    );

    if (contract.count === 1) {
      for (const path of [
        contract.implementation,
        contract.owner,
        publicEntry,
      ]) {
        if (!existsSync(resolve(desktopRoot, path))) {
          violations.push(`${key}: controller owner source is missing: ${path}`);
        }
      }
    }

    let ownerImports = 0;
    let ownerCalls = 0;
    let ownerSymbolExported = false;
    for (const [fileRelative, { analysis, file }] of sourceAnalyses) {
      const targetsImplementation = (source) =>
        resolveDependency(desktopRoot, file, source) === implementationTarget;
      const targetsOwner = (source) =>
        resolveDependency(desktopRoot, file, source) === ownerTarget;
      const targetsPublicEntry = (source) =>
        publicEntryTargets.has(resolveDependency(desktopRoot, file, source));
      const implementationImports = analysis.moduleImports.filter((entry) =>
        targetsImplementation(entry.source),
      );
      const controllerImports = implementationImports.filter(
        (entry) =>
          entry.kind === 'named' && entry.imported === contract.symbol,
      );
      const implementationReexports = analysis.moduleReexports.filter(
        (entry) => targetsImplementation(entry.source),
      );
      const controllerLoads = analysis.moduleLoads.filter((entry) =>
        targetsImplementation(entry.source),
      );
      const ownerProviderImports = analysis.moduleImports.filter(
        (entry) =>
          targetsOwner(entry.source) &&
          (entry.kind !== 'named' || entry.imported === contract.ownerSymbol),
      );
      const ownerProviderReexports = analysis.moduleReexports.filter(
        (entry) =>
          targetsOwner(entry.source) &&
          (entry.kind !== 'named' || entry.imported === contract.ownerSymbol),
      );
      const ownerLoads = analysis.moduleLoads.filter((entry) =>
        targetsOwner(entry.source),
      );

      if (fileRelative === contract.owner) {
        ownerImports += controllerImports.length;
        ownerCalls += controllerImports.reduce(
          (total, entry) => total + entry.directCalls,
          0,
        );
        const directOwnerExports = analysis.moduleDirectExports.filter(
          (entry) =>
            entry.local === contract.ownerSymbol &&
            entry.exported === contract.ownerSymbol,
        );
        ownerSymbolExported = directOwnerExports.length === 1;
        for (const entry of directOwnerExports) {
          const valueUsages =
            entry.directCalls +
            entry.references +
            Object.values(entry.memberCalls).reduce(
              (total, count) => total + count,
              0,
            ) +
            Object.values(entry.memberReferences).reduce(
              (total, count) => total + count,
              0,
            );
          if (valueUsages > 0) {
            violations.push(
              `${key}: owner must expose ${contract.ownerSymbol} only as a JSX component`,
            );
          }
        }
        if (implementationImports.length !== controllerImports.length) {
          violations.push(
            `${key}: owner may only import the registered controller symbol`,
          );
        }
        if (controllerLoads.length > 0) {
          violations.push(
            `${key}: owner must consume the controller through one direct import`,
          );
        }
        for (const entry of controllerImports) {
          const indirectReferences =
            entry.references +
            Object.values(entry.memberCalls).reduce(
              (total, count) => total + count,
              0,
            ) +
            Object.values(entry.memberReferences).reduce(
              (total, count) => total + count,
              0,
            );
          if (indirectReferences > 0) {
            violations.push(
              `${key}: owner must not alias or expose the controller binding`,
            );
          }
          if (
            entry.directCallOwners.some(
              (ownerSymbol) => ownerSymbol !== contract.ownerSymbol,
            )
          ) {
            violations.push(
              `${key}: controller must be called inside ${contract.ownerSymbol}`,
            );
          }
        }
      } else if (implementationImports.length > 0) {
        violations.push(
          `${key}: controller implementation is imported by non-owner ${fileRelative}`,
        );
      }

      const testingOnlyNamedExport =
        fileRelative === testingEntry &&
        implementationReexports.length > 0 &&
        implementationReexports.every(
          (entry) =>
            entry.kind === 'named' && entry.imported === contract.symbol,
        );
      if (controllerLoads.length > 0 && fileRelative !== contract.owner) {
        violations.push(
          `${key}: controller implementation is referenced by non-owner ${fileRelative}`,
        );
      }

      if (implementationReexports.length > 0) {
        if (!testingOnlyNamedExport) {
          violations.push(
            `${key}: controller implementation is re-exported by ${fileRelative}`,
          );
        }
      }

      if (
        fileRelative === publicEntry &&
        (implementationImports.length > 0 ||
          implementationReexports.length > 0)
      ) {
        violations.push(
          `${key}: public feature entry must not expose the controller`,
        );
      }

      if (
        fileRelative !== publicEntry &&
        fileRelative !== testingEntry &&
        !isTestConsumer(file) &&
        (ownerProviderImports.length > 0 ||
          ownerProviderReexports.length > 0 ||
          ownerLoads.length > 0)
      ) {
        violations.push(
          `${key}: ${fileRelative} must consume ${contract.ownerSymbol} through the public feature entry`,
        );
      }

      if (fileRelative === publicEntry) {
        const ownerImportsFromImplementation = analysis.moduleImports.filter(
          (entry) =>
            targetsOwner(entry.source) &&
            (entry.kind === 'namespace' ||
              (entry.kind === 'named' &&
                entry.imported === contract.ownerSymbol)),
        );
        if (ownerImportsFromImplementation.length > 0) {
          violations.push(
            `${key}: public feature entry must re-export the owner directly`,
          );
        }
        const ownerReexports = analysis.moduleReexports.filter(
          (entry) => targetsOwner(entry.source),
        );
        const registeredOwnerReexports = ownerReexports.filter(
          (entry) =>
            entry.kind === 'named' && entry.imported === contract.ownerSymbol,
        );
        if (
          contract.count === 1 &&
          !registeredOwnerReexports.some(
            (entry) => entry.exported === contract.ownerSymbol,
          )
        ) {
          violations.push(
            `${key}: public feature entry must export ${contract.ownerSymbol} without renaming it`,
          );
        }
        if (
          ownerReexports.some(
            (entry) =>
              entry.kind !== 'named' ||
              (entry.imported === contract.ownerSymbol &&
                entry.exported !== contract.ownerSymbol),
          )
        ) {
          violations.push(
            `${key}: public feature entry must not alias or wildcard-export the owner`,
          );
        }
      }

      if (fileRelative !== publicEntry && !isTestConsumer(file)) {
        const publicImports = analysis.moduleImports.filter(
          (entry) => targetsPublicEntry(entry.source),
        );
        const publicOwnerReexports = analysis.moduleReexports.filter(
          (entry) =>
            targetsPublicEntry(entry.source) &&
            (entry.kind !== 'named' || entry.imported === contract.ownerSymbol),
        );
        for (const entry of publicImports) {
          const directOwnerCall =
            entry.kind === 'named' &&
            entry.imported === contract.ownerSymbol &&
            (entry.directCalls > 0 || entry.references > 0);
          const namespaceOwnerCall =
            entry.kind === 'namespace' &&
            ((entry.memberCalls[contract.ownerSymbol] ?? 0) > 0 ||
              (entry.memberReferences[contract.ownerSymbol] ?? 0) > 0 ||
              entry.references > 0);
          if (directOwnerCall || namespaceOwnerCall) {
            violations.push(
              `${key}: ${fileRelative} must mount ${contract.ownerSymbol} through JSX`,
            );
          }
        }
        if (publicOwnerReexports.length > 0) {
          violations.push(
            `${key}: ${fileRelative} must not re-export ${contract.ownerSymbol} from the public feature entry`,
          );
        }
        if (analysis.moduleLoads.some((entry) => targetsPublicEntry(entry.source))) {
          violations.push(
            `${key}: ${fileRelative} must import ${contract.ownerSymbol} statically and mount it through JSX`,
          );
        }
      }
    }

    if (ownerImports !== contract.count) {
      violations.push(
        `${key}: owner must directly import the controller ${contract.count} time(s), received ${ownerImports}`,
      );
    }
    if (ownerCalls !== contract.count) {
      violations.push(
        `${key}: owner ${contract.owner} must call the controller ${contract.count} time(s), received ${ownerCalls}`,
      );
    }
    if (contract.count === 1 && !ownerSymbolExported) {
      violations.push(
        `${key}: owner must export ${contract.ownerSymbol}`,
      );
    }
  }
}

function isPublicFeaturePath(subpath) {
  return subpath === '' || subpath === 'index';
}

function isFeatureTestSupportEntry(subpath) {
  return subpath === 'stories' || subpath === 'testing';
}

function isApplicationContractPath(path) {
  return path === 'src/renderer/application/contracts' || path.startsWith('src/renderer/application/contracts/');
}

function isPublicApplicationPath(path) {
  if (isApplicationContractPath(path)) return true;
  return /^src\/renderer\/application\/[^/]+(?:\/index)?$/u.test(path);
}

function isForbiddenEnvironmentDependency(dependency) {
  return FORBIDDEN_ENVIRONMENT_IMPORTS.has(dependency) || dependency.startsWith('electron/');
}

function validateDependencies({
  allowedLegacyFeatureImports,
  allowedLegacyPlatformImports,
  analysis,
  desktopRoot,
  file,
  fileRelative,
  observedLegacyFeatureImports,
  observedLegacyPlatformImports,
  violations,
}) {
  const sourceZone = zoneFor(fileRelative);
  for (const dependency of analysis.dependencies) {
    if (
      ['application', 'bootstrap', 'composition', 'feature', 'platform', 'shell'].includes(sourceZone.kind) &&
      !isTestConsumer(file) &&
      isForbiddenEnvironmentDependency(dependency)
    ) {
      violations.push(`${fileRelative}: ${sourceZone.kind} code imports forbidden environment module: ${dependency}`);
      continue;
    }
    const target = resolveDependency(desktopRoot, file, dependency);
    if (!target) continue;
    const targetRelative = normalizePath(relative(desktopRoot, target));
    const targetZone = zoneFor(targetRelative);
    const targetFeature = featureForAbsolutePath(desktopRoot, target);

    if (targetFeature) {
      if (sourceZone.kind === 'feature' && sourceZone.name !== targetFeature.name) {
        violations.push(`${fileRelative}: feature ${sourceZone.name} imports feature ${targetFeature.name}: ${dependency}`);
        continue;
      }
      if (
        sourceZone.kind === 'feature' &&
        sourceZone.name === targetFeature.name &&
        isFeatureTestSupportEntry(targetFeature.subpath) &&
        !isFeatureTestSupportEntry(sourceZone.subpath) &&
        !isTestConsumer(file)
      ) {
        violations.push(
          `${fileRelative}: feature production code cannot import its ${targetFeature.subpath} entry: ${dependency}`,
        );
      }
      if (sourceZone.kind !== 'feature') {
        const supportEntry = isFeatureTestSupportEntry(targetFeature.subpath);
        if (!isPublicFeaturePath(targetFeature.subpath) && !(supportEntry && isTestConsumer(file))) {
          violations.push(
            `${fileRelative}: feature imports must use index${isTestConsumer(file) ? ', testing, or stories' : ''}: ${dependency}`,
          );
        }
        if (supportEntry && !isTestConsumer(file)) {
          violations.push(
            `${fileRelative}: production code imports a feature ${targetFeature.subpath} entry: ${dependency}`,
          );
        }
      }
    }

    if (sourceZone.kind === 'feature') {
      if (targetZone.kind === 'legacy' && !isValidatedCopyCatalog(desktopRoot, targetRelative)) {
        const edge = `${fileRelative} -> ${targetRelative}`;
        observedLegacyFeatureImports.add(edge);
        if (!allowedLegacyFeatureImports.has(edge)) {
          violations.push(`${fileRelative}: feature imports unbudgeted renderer legacy code: ${dependency}`);
        }
      }
      if (targetZone.kind === 'application' && !isApplicationContractPath(targetRelative)) {
        violations.push(`${fileRelative}: feature imports application implementation instead of a contract: ${dependency}`);
      }
      if (['bootstrap', 'composition', 'main', 'platform', 'preload', 'shell'].includes(targetZone.kind)) {
        violations.push(`${fileRelative}: feature imports a forbidden Desktop/shell module: ${dependency}`);
      }
    }

    if (sourceZone.kind === 'shell') {
      const allowedApplicationContract = isApplicationContractPath(targetRelative);
      if (
        targetZone.kind === 'feature' ||
        targetZone.kind === 'platform' ||
        targetZone.kind === 'legacy' ||
        targetZone.kind === 'bootstrap' ||
        targetZone.kind === 'composition' ||
        (targetZone.kind === 'application' && !allowedApplicationContract) ||
        targetZone.kind === 'main' ||
        targetZone.kind === 'preload'
      ) {
        violations.push(`${fileRelative}: shell imports forbidden implementation module: ${dependency}`);
      }
    }

    if (sourceZone.kind === 'application') {
      if (
        sourceZone.subpath === 'contracts' ||
        sourceZone.subpath.startsWith('contracts/')
      ) {
        if (targetZone.kind === 'application' && !isApplicationContractPath(targetRelative)) {
          violations.push(`${fileRelative}: application contracts import application implementation: ${dependency}`);
        }
      }
      if (
        targetZone.kind === 'feature' ||
        targetZone.kind === 'platform' ||
        targetZone.kind === 'shell' ||
        targetZone.kind === 'bootstrap' ||
        targetZone.kind === 'composition' ||
        targetZone.kind === 'legacy' ||
        targetZone.kind === 'main' ||
        targetZone.kind === 'preload'
      ) {
        violations.push(`${fileRelative}: application authority imports an outer implementation: ${dependency}`);
      }
    }

    if (sourceZone.kind === 'composition') {
      if (targetZone.kind === 'application' && !isPublicApplicationPath(targetRelative)) {
        violations.push(`${fileRelative}: composition imports application implementation instead of a public entry: ${dependency}`);
      }
      const allowedLegacyAdapter =
        fileRelative === LEGACY_APP_SHELL_ADAPTER && targetRelative === LEGACY_APP_SHELL_MODULE;
      if (
        targetZone.kind === 'bootstrap' ||
        targetZone.kind === 'main' ||
        targetZone.kind === 'preload' ||
        (targetZone.kind === 'legacy' && !allowedLegacyAdapter)
      ) {
        violations.push(`${fileRelative}: composition imports a forbidden implementation module: ${dependency}`);
      }
    }

    if (sourceZone.kind === 'bootstrap') {
      if (!['bootstrap', 'composition', 'external', 'platform'].includes(targetZone.kind)) {
        violations.push(`${fileRelative}: bootstrap imports outside composition/platform: ${dependency}`);
      }
    }

    if (sourceZone.kind === 'platform') {
      if (targetZone.kind === 'application' && !isPublicApplicationPath(targetRelative)) {
        violations.push(`${fileRelative}: Desktop adapter imports application implementation instead of a public entry: ${dependency}`);
      }
      if (targetZone.kind === 'legacy' && !isValidatedCopyCatalog(desktopRoot, targetRelative)) {
        const edge = `${fileRelative} -> ${targetRelative}`;
        observedLegacyPlatformImports.add(edge);
        if (!allowedLegacyPlatformImports.has(edge)) {
          violations.push(`${fileRelative}: Desktop adapter imports unbudgeted renderer legacy code: ${dependency}`);
        }
      }
      if (['bootstrap', 'composition', 'main', 'shell'].includes(targetZone.kind)) {
        violations.push(`${fileRelative}: Desktop adapter imports an outer or legacy implementation: ${dependency}`);
      }
    }

    if (
      sourceZone.kind === 'legacy' &&
      targetZone.kind === 'application' &&
      !isPublicApplicationPath(targetRelative)
    ) {
      violations.push(`${fileRelative}: legacy renderer code imports application implementation instead of a public entry: ${dependency}`);
    }
  }
}

function validateStrictZone({ fileRelative, analysis, violations }) {
  const zone = zoneFor(fileRelative);
  if (['application', 'bootstrap', 'composition', 'feature', 'shell'].includes(zone.kind)) {
    if (Object.keys(analysis.bridgePaths).length > 0) {
      violations.push(`${fileRelative}: ${zone.kind} code accesses the Desktop global bridge`);
    }
    if (Object.keys(analysis.environmentCapabilities).some((path) => path.endsWith('.*'))) {
      violations.push(`${fileRelative}: ${zone.kind} code contains non-static global environment access`);
    }
  }
  if (['bootstrap', 'composition', 'platform', 'shell'].includes(zone.kind)) {
    if (Object.keys(analysis.hookCalls).length > 0) {
      violations.push(`${fileRelative}: ${zone.kind} code owns stateful React hooks`);
    }
    if (Object.keys(analysis.lifecycleMethods).length > 0) {
      violations.push(`${fileRelative}: ${zone.kind} code owns React class lifecycle methods`);
    }
    const environmentPaths = Object.keys(analysis.environmentCapabilities);
    const bootstrapEnvironmentIsOnlyMountLookup =
      zone.kind === 'bootstrap' &&
      environmentPaths.every((path) => ['document.getElementById', 'document.querySelector'].includes(path));
    if (zone.kind !== 'platform' && environmentPaths.length > 0 && !bootstrapEnvironmentIsOnlyMountLookup) {
      violations.push(`${fileRelative}: ${zone.kind} code directly accesses browser environment capabilities`);
    }
  }
  if (zone.kind === 'platform' && (/\.(?:(?:c|m)?(?:jsx|tsx))$/u.test(fileRelative) || analysis.dependencies.includes('react'))) {
    violations.push(`${fileRelative}: Desktop adapters cannot own React UI`);
  }
  if (['application', 'bootstrap', 'composition', 'feature', 'platform', 'shell'].includes(zone.kind) && analysis.unresolvedDependencies > 0) {
    violations.push(`${fileRelative}: ${zone.kind} code contains a non-static import or require`);
  }
}

function validateMetric(path, metric, actual, expected, violations) {
  if (metric === 'actionFactories') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      violations.push(`${path}: ${metric} changed; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (typeof expected === 'number') {
    if (actual !== expected) violations.push(`${path}: ${metric} changed; expected ${expected}, received ${actual}`);
    return;
  }
  if (!sameJson(actual, expected)) {
    violations.push(`${path}: ${metric} changed; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function validateDebtFile(desktopRoot, path, expected, violations, metrics = ROOT_DEBT_METRICS) {
  const absolutePath = resolve(desktopRoot, path);
  if (!existsSync(absolutePath)) {
    violations.push(`${path}: debt ledger entry points to a missing file`);
    return;
  }
  const analysis = analyzeRendererSource(readFileSync(absolutePath, 'utf8'), path);
  for (const metric of metrics) {
    validateMetric(path, metric, analysis[metric], expected[metric], violations);
  }
}

function validateLegacyLedger(desktopRoot, config, violations) {
  const rendererRoot = resolve(desktopRoot, 'src/renderer');
  const actualLegacyFiles = sourceFiles(rendererRoot)
    .map((path) => normalizePath(relative(desktopRoot, path)))
    .filter((path) => zoneFor(path).kind === 'legacy')
    .sort();
  const expectedLegacyFiles = [...config.legacyRendererFiles].sort();
  if (JSON.stringify(actualLegacyFiles) !== JSON.stringify(expectedLegacyFiles)) {
    violations.push(
      `unclassified legacy renderer file set changed; expected ${JSON.stringify(expectedLegacyFiles)}, received ${JSON.stringify(actualLegacyFiles)}`,
    );
  }

  const actualFiles = readdirSync(rendererRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LEGACY_APP_SHELL_FILE.test(entry.name))
    .map((entry) => `src/renderer/${entry.name}`)
    .sort();
  const expectedFiles = Object.keys(config.legacyAppShell.files).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    violations.push(`legacy AppShell file set changed; expected ${JSON.stringify(expectedFiles)}, received ${JSON.stringify(actualFiles)}`);
  }

  for (const [path, expected] of Object.entries(config.legacyAppShell.files)) {
    validateDebtFile(desktopRoot, path, expected, violations);
  }
  const actualClosure = collectRootDependencyClosure(desktopRoot, expectedFiles, violations, 'AppShell');
  const expectedClosure = Object.keys(config.legacyAppShell.closure).sort();
  if (JSON.stringify(actualClosure) !== JSON.stringify(expectedClosure)) {
    violations.push(
      `legacy AppShell transitive renderer closure changed; expected ${JSON.stringify(expectedClosure)}, received ${JSON.stringify(actualClosure)}`,
    );
  }
  for (const [path, expected] of Object.entries(config.legacyAppShell.closure)) {
    if (config.legacyAppShell.files[path]) {
      violations.push(`${path}: AppShell root file must not also appear in its transitive closure`);
      continue;
    }
    if (!isRootClosureDebtSource(path) || DECLARATION_FILE.test(path)) {
      violations.push(`${path}: AppShell closure debt must point to a non-owner Desktop source`);
    }
    validateDebtFile(desktopRoot, path, expected, violations, CAPABILITY_DEBT_METRICS);
  }
  for (const [path, expected] of Object.entries(config.rootDebt)) {
    validateDebtFile(desktopRoot, path, expected, violations);
  }
  const appShellDebtPaths = new Set([...expectedFiles, ...expectedClosure]);
  const rootDebtPaths = Object.keys(config.rootDebt).sort();
  const actualRootClosure = collectRootDependencyClosure(desktopRoot, rootDebtPaths, violations, 'renderer root')
    .filter((path) => !appShellDebtPaths.has(path));
  const expectedRootClosure = Object.keys(config.rootDebtClosure).sort();
  if (JSON.stringify(actualRootClosure) !== JSON.stringify(expectedRootClosure)) {
    violations.push(
      `renderer root transitive legacy closure changed; expected ${JSON.stringify(expectedRootClosure)}, received ${JSON.stringify(actualRootClosure)}`,
    );
  }
  for (const [path, expected] of Object.entries(config.rootDebtClosure)) {
    if (config.rootDebt[path] || appShellDebtPaths.has(path)) {
      violations.push(`${path}: renderer root closure debt overlaps another root debt section`);
      continue;
    }
    if (!isRootClosureDebtSource(path) || DECLARATION_FILE.test(path)) {
      violations.push(`${path}: renderer root closure debt must point to a non-owner Desktop source`);
    }
    validateDebtFile(desktopRoot, path, expected, violations, CAPABILITY_DEBT_METRICS);
  }

  const ownedPaths = new Map();
  for (const owner of config.ownership) {
    if (!owner.capability || !owner.targetZone || !Array.isArray(owner.legacyPaths)) {
      violations.push('ownership entries require capability, targetZone, and legacyPaths');
      continue;
    }
    for (const path of owner.legacyPaths) {
      if (ownedPaths.has(path)) {
        violations.push(`${path}: assigned to both ${ownedPaths.get(path)} and ${owner.capability}`);
      }
      ownedPaths.set(path, owner.capability);
    }
  }
  const expectedOwnedPaths = [...expectedFiles, ...Object.keys(config.rootDebt)];
  for (const path of expectedOwnedPaths) {
    if (!ownedPaths.has(path)) violations.push(`${path}: missing target owner in the architecture ledger`);
  }
  for (const path of ownedPaths.keys()) {
    if (!config.legacyAppShell.files[path] && !config.rootDebt[path]) {
      violations.push(`${path}: ownership ledger path is not recorded renderer root debt`);
    }
  }
}

function htmlAttribute(attributes, name) {
  const match = attributes.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu'),
  );
  return match?.[1] ?? match?.[2];
}

function parseContractSource(desktopRoot, path, violations) {
  const absolutePath = resolve(desktopRoot, path);
  if (!existsSync(absolutePath)) {
    violations.push(`${path}: renderer entry contract source is missing`);
    return undefined;
  }
  try {
    return parse(readFileSync(absolutePath, 'utf8'), {
      createImportExpressions: true,
      errorRecovery: false,
      plugins: PARSER_PLUGINS.filter((plugin) => plugin !== 'jsx'),
      sourceFilename: path,
      sourceType: 'module',
    }).program;
  } catch (error) {
    violations.push(
      `${path}: could not parse renderer entry contract: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function nodesIn(program) {
  if (!program) return [];
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    for (const child of childNodes(node)) visit(child);
  }
  visit(program);
  return nodes;
}

function objectPropertyValues(object, name) {
  if (object?.type !== 'ObjectExpression') return [];
  return object.properties
    .filter(
      (property) =>
        property.type === 'ObjectProperty' &&
        !property.computed &&
        memberName(property.key) === name,
    )
    .map((property) => unwrapExpression(property.value));
}

function isIdentifier(node, name) {
  return unwrapExpression(node)?.type === 'Identifier' && unwrapExpression(node).name === name;
}

function hasNamedImport(program, source, importedName, localName = importedName) {
  return program.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      staticString(node.source) === source &&
      node.specifiers.some(
        (specifier) =>
          specifier.type === 'ImportSpecifier' &&
          memberName(specifier.imported) === importedName &&
          specifier.local.name === localName,
      ),
  );
}

function hasDefaultImport(program, source, localName) {
  return program.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      staticString(node.source) === source &&
      node.specifiers.some(
        (specifier) =>
          specifier.type === 'ImportDefaultSpecifier' && specifier.local.name === localName,
      ),
  );
}

function isNamedMember(node, objectName, propertyName) {
  const expression = unwrapExpression(node);
  return (
    isMemberExpression(expression) &&
    isIdentifier(expression.object, objectName) &&
    memberPropertyName(expression) === propertyName
  );
}

function isMemberCall(node, objectName, methodName, argumentObject, argumentProperty) {
  const expression = unwrapExpression(node);
  return (
    expression?.type === 'CallExpression' &&
    isMemberExpression(expression.callee) &&
    isIdentifier(expression.callee.object, objectName) &&
    memberPropertyName(expression.callee) === methodName &&
    expression.arguments.length === 1 &&
    isNamedMember(expression.arguments[0], argumentObject, argumentProperty)
  );
}

function isRendererEntryPathInitializer(node) {
  const expression = unwrapExpression(node);
  return (
    expression?.type === 'CallExpression' &&
    isIdentifier(expression.callee, 'join') &&
    expression.arguments.length === 5 &&
    isIdentifier(expression.arguments[0], 'mainModuleDirectory') &&
    JSON.stringify(expression.arguments.slice(1).map(staticString)) ===
      JSON.stringify(['..', '..', 'dist-renderer', 'index.html'])
  );
}

function isRendererEntryUrlInitializer(node) {
  const expression = unwrapExpression(node);
  if (expression?.type !== 'LogicalExpression' || expression.operator !== '??') return false;
  const left = unwrapExpression(expression.left);
  const right = unwrapExpression(expression.right);
  const viteDevServerUrl = isIdentifier(left, 'viteDevServerUrl');
  const fileUrl =
    isMemberExpression(right) &&
    memberPropertyName(right) === 'href' &&
    unwrapExpression(right.object)?.type === 'CallExpression' &&
    isIdentifier(unwrapExpression(right.object).callee, 'pathToFileURL') &&
    unwrapExpression(right.object).arguments.length === 1 &&
    isIdentifier(unwrapExpression(right.object).arguments[0], 'rendererEntryPath');
  return viteDevServerUrl && fileUrl;
}

function isViteDevServerFlag(node) {
  const expression = unwrapExpression(node);
  const inner = expression?.type === 'UnaryExpression' && expression.operator === '!' ? unwrapExpression(expression.argument) : undefined;
  return (
    inner?.type === 'UnaryExpression' &&
    inner.operator === '!' &&
    isIdentifier(inner.argument, 'viteDevServerUrl')
  );
}

function frozenRendererEntryObject(node) {
  const expression = unwrapExpression(node);
  if (
    expression?.type !== 'CallExpression' ||
    expression.arguments.length !== 1 ||
    !isMemberExpression(expression.callee) ||
    expression.callee.computed ||
    !isIdentifier(expression.callee.object, 'Object') ||
    memberPropertyName(expression.callee) !== 'freeze'
  ) {
    return undefined;
  }
  const object = unwrapExpression(expression.arguments[0]);
  return object?.type === 'ObjectExpression' ? object : undefined;
}

function expressionRootIdentifier(node) {
  let expression = unwrapExpression(node);
  while (isMemberExpression(expression)) expression = unwrapExpression(expression.object);
  return expression?.type === 'Identifier' ? expression.name : undefined;
}

function mutatesIdentifier(node, name) {
  if (node.type === 'AssignmentExpression') return expressionRootIdentifier(node.left) === name;
  if (node.type === 'UpdateExpression') return expressionRootIdentifier(node.argument) === name;
  return (
    node.type === 'UnaryExpression' &&
    node.operator === 'delete' &&
    expressionRootIdentifier(node.argument) === name
  );
}

function navigationApiToken(node) {
  if (node?.type === 'Identifier' && ['loadFile', 'loadURL'].includes(node.name)) return node.name;
  const value = staticString(node);
  if (['loadFile', 'loadURL'].includes(value ?? '')) return value;
  return undefined;
}

function isOnlyAwaitedMemberCall(block, objectName, methodName, argumentObject, argumentProperty) {
  if (block?.type !== 'BlockStatement' || block.body.length !== 1) return false;
  const [statement] = block.body;
  const expression = statement?.type === 'ExpressionStatement' ? unwrapExpression(statement.expression) : undefined;
  return (
    expression?.type === 'AwaitExpression' &&
    isMemberCall(expression.argument, objectName, methodName, argumentObject, argumentProperty)
  );
}

function isImportMetaDirectory(node) {
  const expression = unwrapExpression(node);
  return (
    isMemberExpression(expression) &&
    unwrapExpression(expression.object)?.type === 'MetaProperty' &&
    unwrapExpression(expression.object).meta?.name === 'import' &&
    unwrapExpression(expression.object).property?.name === 'meta' &&
    memberPropertyName(expression) === 'dirname'
  );
}

function isProcessViteDevServerUrl(node) {
  const expression = unwrapExpression(node);
  return (
    isMemberExpression(expression) &&
    isMemberExpression(expression.object) &&
    isIdentifier(expression.object.object, 'process') &&
    memberPropertyName(expression.object) === 'env' &&
    memberPropertyName(expression) === 'VITE_DEV_SERVER_URL'
  );
}

function validateMainRendererLoader(desktopRoot, violations) {
  const program = parseContractSource(desktopRoot, MAIN_RENDERER_LOADER_SOURCE, violations);
  if (!program) return;
  const nodes = nodesIn(program);
  const declarators = (name) =>
    nodes.filter(
      (node) =>
        node.type === 'VariableDeclarator' &&
        node.id?.type === 'Identifier' &&
        node.id.name === name,
    );
  const entryPaths = declarators('rendererEntryPath');
  const entryUrls = declarators('rendererEntryUrl');
  const loadCalls = nodes.filter(
    (node) =>
      node.type === 'CallExpression' &&
      isMemberExpression(node.callee) &&
      ['loadFile', 'loadURL'].includes(memberPropertyName(node.callee)),
  );
  const loaderFunctions = nodes.filter(
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'loadMainRenderer',
  );
  const resolverFunctions = nodes.filter(
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'resolveMainRendererEntry',
  );
  const [loaderFunction] = loaderFunctions;
  const [resolverFunction] = resolverFunctions;
  const ifStatements = loaderFunction ? nodesIn(loaderFunction.body).filter((node) => node.type === 'IfStatement') : [];
  const [loadBranch] = ifStatements;
  const resolverReturns = resolverFunction
    ? nodesIn(resolverFunction.body).filter((node) => node.type === 'ReturnStatement')
    : [];
  const [resolverReturn] = resolverReturns;
  const frozenEntry = frozenRendererEntryObject(resolverReturn?.argument);
  const returnFilePaths = objectPropertyValues(frozenEntry, 'filePath');
  const returnUrls = objectPropertyValues(frozenEntry, 'url');
  const returnDevFlags = objectPropertyValues(frozenEntry, 'useDevServer');
  const navigationTokens = nodes.filter((node) => navigationApiToken(node));
  const valid =
    hasNamedImport(program, 'node:path', 'join') &&
    hasNamedImport(program, 'node:url', 'pathToFileURL') &&
    !program.body.some((statement) => statementBindings(statement).includes('Object')) &&
    resolverFunctions.length === 1 &&
    resolverFunction.async !== true &&
    JSON.stringify(resolverFunction.params.map((parameter) => parameter.type === 'Identifier' ? parameter.name : undefined)) ===
      JSON.stringify(['mainModuleDirectory', 'viteDevServerUrl']) &&
    resolverFunction.body.body.length === 3 &&
    resolverReturns.length === 1 &&
    Boolean(frozenEntry) &&
    returnFilePaths.length === 1 &&
    isIdentifier(returnFilePaths[0], 'rendererEntryPath') &&
    returnUrls.length === 1 &&
    isIdentifier(returnUrls[0], 'rendererEntryUrl') &&
    returnDevFlags.length === 1 &&
    isViteDevServerFlag(returnDevFlags[0]) &&
    loaderFunctions.length === 1 &&
    loaderFunction.async === true &&
    JSON.stringify(loaderFunction.params.map((parameter) => parameter.type === 'Identifier' ? parameter.name : undefined)) ===
      JSON.stringify(['mainWindow', 'rendererEntry']) &&
    loaderFunction.body.body.length === 1 &&
    entryPaths.length === 1 &&
    isRendererEntryPathInitializer(entryPaths[0].init) &&
    entryUrls.length === 1 &&
    isRendererEntryUrlInitializer(entryUrls[0].init) &&
    loadCalls.length === 2 &&
    loadCalls.filter((node) => isMemberCall(node, 'mainWindow', 'loadFile', 'rendererEntry', 'filePath')).length === 1 &&
    loadCalls.filter((node) => isMemberCall(node, 'mainWindow', 'loadURL', 'rendererEntry', 'url')).length === 1 &&
    navigationTokens.length === 4 &&
    ifStatements.length === 1 &&
    isNamedMember(loadBranch.test, 'rendererEntry', 'useDevServer') &&
    isOnlyAwaitedMemberCall(loadBranch.consequent, 'mainWindow', 'loadURL', 'rendererEntry', 'url') &&
    isOnlyAwaitedMemberCall(loadBranch.alternate, 'mainWindow', 'loadFile', 'rendererEntry', 'filePath');
  if (!valid) {
    violations.push(
      `${MAIN_RENDERER_LOADER_SOURCE}: renderer loader must load only the pinned dist-renderer/index.html entry`,
    );
  }
}

function validateMainWindowEntryContract(desktopRoot, violations) {
  const program = parseContractSource(desktopRoot, RENDERER_LOADER_SOURCE, violations);
  if (!program) return;
  const nodes = nodesIn(program);
  const parents = buildParentMap(program);
  const loaderImports = program.body.filter(
    (node) =>
      node.type === 'ImportDeclaration' &&
      staticString(node.source) === './main-renderer-loader.js' &&
      ['loadMainRenderer', 'resolveMainRendererEntry'].every((name) =>
        node.specifiers.some(
          (specifier) =>
            specifier.type === 'ImportSpecifier' &&
            memberName(specifier.imported) === name &&
            specifier.local.name === name,
        ),
      ),
  );
  const entryDeclarators = nodes.filter(
    (node) =>
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.id.name === 'rendererEntry' &&
      unwrapExpression(node.init)?.type === 'CallExpression' &&
      isIdentifier(unwrapExpression(node.init).callee, 'resolveMainRendererEntry') &&
      unwrapExpression(node.init).arguments.length === 2 &&
      isImportMetaDirectory(unwrapExpression(node.init).arguments[0]) &&
      isProcessViteDevServerUrl(unwrapExpression(node.init).arguments[1]),
  );
  const loaderCalls = nodes.filter(
    (node) =>
      node.type === 'CallExpression' &&
      isIdentifier(node.callee, 'loadMainRenderer') &&
      node.arguments.length === 2 &&
      isIdentifier(node.arguments[0], 'mainWindow') &&
      isIdentifier(node.arguments[1], 'rendererEntry'),
  );
  const entryDeclaration = entryDeclarators.length === 1 ? parents.get(entryDeclarators[0]) : undefined;
  const entryMutations = nodes.filter((node) => mutatesIdentifier(node, 'rendererEntry'));
  if (
    loaderImports.length !== 1 ||
    entryDeclarators.length !== 1 ||
    entryDeclaration?.type !== 'VariableDeclaration' ||
    entryDeclaration.kind !== 'const' ||
    loaderCalls.length !== 1 ||
    entryMutations.length > 0 ||
    nodes.some((node) => navigationApiToken(node))
  ) {
    violations.push(
      `${RENDERER_LOADER_SOURCE}: main window must delegate exactly once to the pinned renderer loader`,
    );
  }

  const allowedNavigationFiles = new Set([
    'src/main/browser-message-box.ts',
    'src/main/browser/controller.ts',
    'src/main/computer-use/cursor-overlay-window.ts',
    'src/main/computer-use/pip-electron.ts',
    MAIN_RENDERER_LOADER_SOURCE,
    'src/main/permission-overlay/permission-overlay-main.ts',
  ]);
  for (const file of sourceFiles(resolve(desktopRoot, 'src/main'))) {
    const fileRelative = normalizePath(relative(desktopRoot, file));
    if (isTestConsumer(fileRelative) || allowedNavigationFiles.has(fileRelative)) continue;
    const sourceProgram = parseContractSource(desktopRoot, fileRelative, violations);
    if (sourceProgram && nodesIn(sourceProgram).some((node) => navigationApiToken(node))) {
      violations.push(`${fileRelative}: main-process navigation APIs are restricted to approved loaders`);
    }
  }

  validateMainRendererLoader(desktopRoot, violations);
}

function validateViteEntryContract(desktopRoot, violations) {
  const program = parseContractSource(desktopRoot, RENDERER_VITE_CONFIG, violations);
  if (!program) return;
  const defaultExports = program.body.filter((node) => node.type === 'ExportDefaultDeclaration');
  const declaration = unwrapExpression(defaultExports[0]?.declaration);
  const config =
    defaultExports.length === 1 &&
    declaration?.type === 'CallExpression' &&
    isIdentifier(declaration.callee, 'defineConfig') &&
    declaration.arguments.length === 1
      ? unwrapExpression(declaration.arguments[0])
      : undefined;
  const roots = objectPropertyValues(config, 'root');
  const builds = objectPropertyValues(config, 'build');
  const plugins = objectPropertyValues(config, 'plugins');
  const outDirs = objectPropertyValues(builds[0], 'outDir');
  const rollupOptions = objectPropertyValues(builds[0], 'rollupOptions');
  const hasInputOverride = rollupOptions.some(
    (options) => options?.type !== 'ObjectExpression' || objectPropertyValues(options, 'input').length > 0,
  );
  const hasContractSpread =
    config?.type !== 'ObjectExpression' ||
    config.properties.some((property) => property.type === 'SpreadElement') ||
    builds[0]?.type !== 'ObjectExpression' ||
    builds[0].properties.some((property) => property.type === 'SpreadElement');
  const pluginElements = plugins[0]?.type === 'ArrayExpression' ? plugins[0].elements : [];
  const pluginCall = (index, name, argumentCount) => {
    const expression = unwrapExpression(pluginElements[index]);
    return expression?.type === 'CallExpression' &&
      isIdentifier(expression.callee, name) &&
      expression.arguments.length === argumentCount
      ? expression
      : undefined;
  };
  const reactCall = pluginCall(0, 'react', 0);
  const dependencyPatchesCall = pluginCall(1, 'dependencyPatchesCachePlugin', 1);
  const workspacePackagesCall = pluginCall(2, 'workspacePackagesPlugin', 1);
  const bundledPackagesCall = pluginCall(3, 'bundledNpmPackagesPlugin', 0);
  const rendererContractCall = pluginCall(4, 'rendererEntryContractPlugin', 1);
  const rendererContractRoot = unwrapExpression(rendererContractCall?.arguments[0]);
  const hasPinnedRendererContractRoot =
    rendererContractRoot?.type === 'CallExpression' &&
    isIdentifier(rendererContractRoot.callee, 'resolve') &&
    rendererContractRoot.arguments.length === 2 &&
    isImportMetaDirectory(rendererContractRoot.arguments[0]) &&
    staticString(rendererContractRoot.arguments[1]) === 'src/renderer';
  const hasPinnedImports =
    hasNamedImport(program, 'vite', 'defineConfig') &&
    hasNamedImport(program, 'node:path', 'resolve') &&
    hasDefaultImport(program, '@vitejs/plugin-react', 'react') &&
    hasNamedImport(program, './vite-dependency-patches.js', 'dependencyPatchesCachePlugin') &&
    hasNamedImport(program, './vite-workspace-packages.js', 'workspacePackagesPlugin') &&
    hasNamedImport(program, './vite-bundled-packages.js', 'bundledNpmPackagesPlugin') &&
    hasNamedImport(
      program,
      './scripts/vite-renderer-entry-contract.js',
      'rendererEntryContractPlugin',
    );
  const hasPinnedPlugins =
    pluginElements.length === 5 &&
    Boolean(reactCall) &&
    Boolean(dependencyPatchesCall) &&
    isIdentifier(dependencyPatchesCall.arguments[0], 'REPO_ROOT') &&
    Boolean(workspacePackagesCall) &&
    isIdentifier(workspacePackagesCall.arguments[0], 'REPO_ROOT') &&
    Boolean(bundledPackagesCall) &&
    Boolean(rendererContractCall) &&
    hasPinnedRendererContractRoot;
  if (
    roots.length !== 1 ||
    staticString(roots[0]) !== 'src/renderer' ||
    builds.length !== 1 ||
    outDirs.length !== 1 ||
    staticString(outDirs[0]) !== '../../dist-renderer' ||
    plugins.length !== 1 ||
    !hasPinnedImports ||
    !hasPinnedPlugins ||
    hasInputOverride ||
    hasContractSpread
  ) {
    violations.push(
      `${RENDERER_VITE_CONFIG}: Vite must build src/renderer/index.html into dist-renderer without an input override`,
    );
  }

  const packagePath = resolve(desktopRoot, 'package.json');
  let buildScript;
  try {
    buildScript = JSON.parse(readFileSync(packagePath, 'utf8')).scripts?.['build:renderer'];
  } catch {
    buildScript = undefined;
  }
  if (buildScript !== RENDERER_BUILD_SCRIPT) {
    violations.push('package.json: build:renderer must retain the pinned Vite renderer entry command');
  }
}

function validateRendererEntryContract(desktopRoot, config, violations) {
  const indexPath = resolve(desktopRoot, RENDERER_ENTRY_INDEX);
  const entryPath = resolve(desktopRoot, RENDERER_ENTRY_SOURCE);
  if (!existsSync(indexPath)) {
    violations.push(`${RENDERER_ENTRY_INDEX}: renderer entry index is missing`);
    return;
  }
  if (!existsSync(entryPath)) {
    violations.push(`${RENDERER_ENTRY_SOURCE}: renderer entry source is missing`);
  }
  if (!Object.hasOwn(config.rootDebt, RENDERER_ENTRY_SOURCE)) {
    violations.push(`${RENDERER_ENTRY_SOURCE}: renderer entry must retain its permanent rootDebt guard`);
  }

  const html = readFileSync(indexPath, 'utf8');
  const openingScriptCount = html.match(/<script\b/giu)?.length ?? 0;
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)];
  const [script] = scripts;
  const isPinnedEntry =
    openingScriptCount === 1 &&
    scripts.length === 1 &&
    htmlAttribute(script?.[1] ?? '', 'type') === 'module' &&
    htmlAttribute(script?.[1] ?? '', 'src') === RENDERER_ENTRY_SCRIPT_SOURCE &&
    (script?.[2] ?? '').trim().length === 0;
  if (!isPinnedEntry) {
    violations.push(
      `${RENDERER_ENTRY_INDEX}: renderer entry contract requires exactly one empty external module script for ${RENDERER_ENTRY_SCRIPT_SOURCE}`,
    );
  }
  validateMainWindowEntryContract(desktopRoot, violations);
  validateViteEntryContract(desktopRoot, violations);
}

function metricTotal(value) {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  return Object.values(value).reduce((total, count) => total + count, 0);
}

const COPY_CATALOG_PATH = /^src\/renderer\/locales\/[a-z0-9-]+-copy\.ts$/u;
const COPY_CATALOG_MARKER_MODULE = '@maka/core/ui-locale';
const COPY_CATALOG_MARKER_TYPE = 'UiCatalog';
const copyCatalogValidationCache = new Map();

function inspectCopyCatalog(source, file) {
  const ast = parse(source, {
    createImportExpressions: true,
    errorRecovery: false,
    plugins: PARSER_PLUGINS.filter((plugin) => plugin !== 'jsx'),
    sourceFilename: file,
    sourceType: 'module',
  });
  let markerLocalName;
  const runtimeDependencies = [];
  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (statement.source.value === COPY_CATALOG_MARKER_MODULE) {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.imported.name === COPY_CATALOG_MARKER_TYPE) {
            markerLocalName = specifier.local.name;
          }
        }
      }
      if (!typeOnlySourceDependency(statement)) runtimeDependencies.push(statement.source.value);
    }
    if (
      (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') &&
      statement.source &&
      !typeOnlySourceDependency(statement)
    ) {
      runtimeDependencies.push(statement.source.value);
    }
    if (
      statement.type === 'TSImportEqualsDeclaration' &&
      statement.moduleReference?.type === 'TSExternalModuleReference' &&
      staticString(statement.moduleReference.expression) !== undefined
    ) {
      runtimeDependencies.push(staticString(statement.moduleReference.expression));
    }
  }
  let markerFound = false;
  function referencesMarker(typeAnnotation) {
    return (
      typeAnnotation?.type === 'TSTypeReference' &&
      typeAnnotation.typeName.type === 'Identifier' &&
      typeAnnotation.typeName.name === markerLocalName
    );
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node.type !== 'string') return;
    if (markerLocalName) {
      if (node.type === 'TSSatisfiesExpression' && referencesMarker(node.typeAnnotation)) markerFound = true;
      if (node.type === 'TSTypeAnnotation' && referencesMarker(node.typeAnnotation)) markerFound = true;
    }
    if (node.type === 'ImportExpression' && staticString(node.source) !== undefined) {
      runtimeDependencies.push(staticString(node.source));
    }
    if (
      (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
      (node.callee?.type === 'Import' ||
        (node.callee?.type === 'Identifier' && node.callee.name === 'require')) &&
      staticString(node.arguments?.[0]) !== undefined
    ) {
      runtimeDependencies.push(staticString(node.arguments[0]));
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      visit(value);
    }
  }
  visit(ast.program.body);
  return { markerFound, runtimeDependencies };
}

// A "validated copy catalog" is the one dependency class the migration ratchet
// admits into legacy files: the locale policy (#2672) forces user-visible copy
// OUT of business files and INTO locales/ catalogs, which necessarily ADDS an
// import edge the debt ratchet would otherwise forbid. The admission is
// structural, re-verified on every run, and never extends to the catalog's own
// runtime dependencies: bare package specifiers only, so a catalog cannot
// become a tunnel to renderer implementation modules. Type-only imports are
// erased at compile time and carry no runtime edge, so they stay admitted
// regardless of target.
function isValidatedCopyCatalog(desktopRoot, path) {
  return copyCatalogFailure(desktopRoot, path) === undefined;
}

function copyCatalogFailure(desktopRoot, path) {
  const relativePath = /\.[a-z]+$/u.test(path) ? path : `${path}.ts`;
  const cacheKey = `${desktopRoot}|${relativePath}`;
  if (copyCatalogValidationCache.has(cacheKey)) return copyCatalogValidationCache.get(cacheKey);
  const failure = validateCopyCatalog(desktopRoot, relativePath);
  copyCatalogValidationCache.set(cacheKey, failure);
  return failure;
}

function validateCopyCatalog(desktopRoot, relativePath) {
  if (!COPY_CATALOG_PATH.test(relativePath)) {
    return 'path does not match src/renderer/locales/*-copy.ts';
  }
  const absolutePath = resolve(desktopRoot, relativePath);
  if (!existsSync(absolutePath)) return 'file does not exist';
  const source = readFileSync(absolutePath, 'utf8');
  let analysis;
  let inspection;
  try {
    analysis = analyzeRendererSource(source, relativePath);
    inspection = inspectCopyCatalog(source, relativePath);
  } catch (error) {
    return `could not analyze source: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!inspection.markerFound) {
    return `missing ${COPY_CATALOG_MARKER_TYPE} marker from ${COPY_CATALOG_MARKER_MODULE}`;
  }
  const capabilityMetrics = {
    actionFactories: analysis.actionFactories,
    bridgePaths: analysis.bridgePaths,
    environmentCapabilities: analysis.environmentCapabilities,
    hookCalls: analysis.hookCalls,
    lifecycleMethods: analysis.lifecycleMethods,
    unresolvedDependencies: analysis.unresolvedDependencies,
  };
  for (const [metric, value] of Object.entries(capabilityMetrics)) {
    if (metricTotal(value) > 0) return `catalog carries ${metric} (${describeMetric(value)})`;
  }
  const forbidden = inspection.runtimeDependencies.find(
    (dependency) => dependency.startsWith('.') || dependency.startsWith(DESKTOP_SELF_PREFIX),
  );
  if (forbidden !== undefined) {
    return `runtime import ${forbidden} is not a bare package specifier`;
  }
  return undefined;
}

function describeMetric(value) {
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.join(', ');
  return Object.keys(value).join(', ');
}

function validateCopyCatalogFiles(desktopRoot, violations) {
  const localesRoot = resolve(desktopRoot, 'src/renderer/locales');
  if (!existsSync(localesRoot)) return;
  for (const file of sourceFiles(localesRoot)) {
    const fileRelative = normalizePath(relative(desktopRoot, file));
    if (!/-copy\.(?:(?:c|m)?ts)$/u.test(fileRelative)) continue;
    const failure = copyCatalogFailure(desktopRoot, fileRelative);
    if (failure !== undefined) {
      violations.push(`${fileRelative}: copy catalog validation failed: ${failure}`);
    }
  }
}

function withoutSanctionedDependencies(desktopRoot, section, importerPath, dependencyPaths) {
  const filtered = {};
  for (const [dependency, count] of Object.entries(dependencyPaths)) {
    if (isSanctionedDependencyTarget(desktopRoot, section, importerPath, dependency)) continue;
    filtered[dependency] = count;
  }
  return filtered;
}

function isSanctionedDependencyTarget(desktopRoot, section, importerPath, dependency) {
  const target = resolveDependency(desktopRoot, resolve(desktopRoot, importerPath), dependency);
  if (!target) return false;
  const targetRelative = normalizePath(relative(desktopRoot, target));
  if (isValidatedCopyCatalog(desktopRoot, targetRelative)) return true;
  // Root entries are meant to become thin mounts; only catalogs are free for them.
  if (section === 'rootDebt') return false;
  if (zoneFor(targetRelative).kind === 'shell' || isPublicApplicationPath(targetRelative)) return true;
  const targetFeature = featureForAbsolutePath(desktopRoot, target);
  return Boolean(targetFeature && isPublicFeaturePath(targetFeature.subpath));
}

const MIGRATION_SWAP_ZONES = {
  rootDebt: ['bootstrap', 'composition'],
  rootDebtClosure: ['application', 'bootstrap', 'composition', 'platform'],
};

function allowsMigrationDependency({ base, current, dependency, desktopRoot, path, section }) {
  const swapZones = MIGRATION_SWAP_ZONES[section];
  if (!swapZones) return false;
  if (metricTotal(current.dependencyPaths) > metricTotal(base.dependencyPaths)) return false;
  const target = resolveDependency(desktopRoot, resolve(desktopRoot, path), dependency);
  if (!target) return false;
  return swapZones.includes(zoneFor(normalizePath(relative(desktopRoot, target))).kind);
}

function debtForPath(desktopRoot, path) {
  return debtMetrics(analyzeRendererSource(readFileSync(resolve(desktopRoot, path), 'utf8'), path));
}

function capabilityDebtForPath(desktopRoot, path) {
  return capabilityDebtMetrics(analyzeRendererSource(readFileSync(resolve(desktopRoot, path), 'utf8'), path));
}

function collectLegacyImportEdges(desktopRoot) {
  const feature = new Set();
  const platform = new Set();
  for (const file of sourceFiles(resolve(desktopRoot, 'src'))) {
    const fileRelative = normalizePath(relative(desktopRoot, file));
    const sourceZone = zoneFor(fileRelative);
    if (sourceZone.kind !== 'feature' && sourceZone.kind !== 'platform') continue;
    const analysis = analyzeRendererSource(readFileSync(file, 'utf8'), fileRelative);
    for (const dependency of analysis.dependencies) {
      const target = resolveDependency(desktopRoot, file, dependency);
      if (!target) continue;
      const targetRelative = normalizePath(relative(desktopRoot, target));
      if (zoneFor(targetRelative).kind !== 'legacy') continue;
      if (isValidatedCopyCatalog(desktopRoot, targetRelative)) continue;
      const edge = `${fileRelative} -> ${targetRelative}`;
      if (sourceZone.kind === 'feature') feature.add(edge);
      else platform.add(edge);
    }
  }
  return { feature: [...feature].sort(), platform: [...platform].sort() };
}

export function generateArchitectureConfig(desktopRoot, config) {
  const rendererRoot = resolve(desktopRoot, 'src/renderer');
  const legacyRendererFiles = sourceFiles(rendererRoot)
    .map((path) => normalizePath(relative(desktopRoot, path)))
    .filter((path) => zoneFor(path).kind === 'legacy')
    .sort();
  const appShellFiles = readdirSync(rendererRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LEGACY_APP_SHELL_FILE.test(entry.name))
    .map((entry) => `src/renderer/${entry.name}`)
    .sort();
  const closureViolations = [];
  const closureFiles = collectRootDependencyClosure(desktopRoot, appShellFiles, closureViolations, 'AppShell');
  if (closureViolations.length > 0) {
    throw new Error(`cannot generate AppShell closure:\n${closureViolations.join('\n')}`);
  }
  const imports = collectLegacyImportEdges(desktopRoot);
  const rootDebt = {};
  for (const path of Object.keys(config.rootDebt ?? {}).sort()) {
    if (existsSync(resolve(desktopRoot, path))) rootDebt[path] = debtForPath(desktopRoot, path);
  }
  const appShellDebtPaths = new Set([...appShellFiles, ...closureFiles]);
  const rootDebtClosureFiles = collectRootDependencyClosure(
    desktopRoot,
    Object.keys(rootDebt),
    closureViolations,
    'renderer root',
  ).filter((path) => !appShellDebtPaths.has(path));
  if (closureViolations.length > 0) {
    throw new Error(`cannot generate renderer root closure:\n${closureViolations.join('\n')}`);
  }
  return {
    version: 1,
    legacyRendererFiles,
    legacyGrowthDirectories: config.legacyGrowthDirectories ?? DEFAULT_LEGACY_GROWTH_DIRECTORIES,
    legacyFeatureImports: imports.feature,
    legacyPlatformImports: imports.platform,
    controllerOwners: controllerOwnersOf(config),
    legacyAppShell: {
      files: Object.fromEntries(appShellFiles.map((path) => [path, debtForPath(desktopRoot, path)])),
      closure: Object.fromEntries(closureFiles.map((path) => [path, capabilityDebtForPath(desktopRoot, path)])),
    },
    rootDebt,
    rootDebtClosure: Object.fromEntries(
      rootDebtClosureFiles.map((path) => [path, capabilityDebtForPath(desktopRoot, path)]),
    ),
    ownership: config.ownership ?? [],
  };
}

function validateMonotonicDebt(config, baseConfig, desktopRoot, violations) {
  if (!baseConfig) return;
  const currentControllerOwners = new Map(
    controllerOwnersOf(config).map((owner) => [controllerOwnerKey(owner), owner]),
  );
  for (const baseOwner of controllerOwnersOf(baseConfig)) {
    const key = controllerOwnerKey(baseOwner);
    const currentOwner = currentControllerOwners.get(key);
    if (!currentOwner) {
      violations.push(`${key}: historical controller owner entries cannot be removed`);
      continue;
    }
    if (
      currentOwner.owner !== baseOwner.owner ||
      currentOwner.ownerSymbol !== baseOwner.ownerSymbol
    ) {
      violations.push(`${key}: historical controller owner cannot change`);
    }
    if (currentOwner.count > baseOwner.count) {
      violations.push(
        `${key}: controller call count cannot increase from ${baseOwner.count} to ${currentOwner.count}`,
      );
    }
  }
  for (const section of ['legacyAppShell', 'legacyAppShellClosure', 'rootDebt', 'rootDebtClosure']) {
    const currentFiles =
      section === 'legacyAppShell'
        ? config.legacyAppShell.files
        : section === 'legacyAppShellClosure'
          ? config.legacyAppShell.closure
          : section === 'rootDebt'
            ? config.rootDebt
            : config.rootDebtClosure;
    const baseFiles =
      section === 'legacyAppShell'
        ? baseConfig.legacyAppShell.files
        : section === 'legacyAppShellClosure'
          ? baseConfig.legacyAppShell.closure
          : section === 'rootDebt'
            ? baseConfig.rootDebt
            : baseConfig.rootDebtClosure;
    for (const path of Object.keys(currentFiles)) {
      const shiftedAppShellBase =
        section === 'rootDebtClosure' ? baseConfig.legacyAppShell.closure[path] : undefined;
      if (
        !baseFiles[path] &&
        !shiftedAppShellBase &&
        !(section.endsWith('Closure') && isValidatedCopyCatalog(desktopRoot, path))
      ) {
        violations.push(`${path}: new ${section} debt entries are forbidden`);
      }
    }
    if (section === 'rootDebt') {
      for (const path of Object.keys(baseFiles)) {
        if (!currentFiles[path] && existsSync(resolve(desktopRoot, path))) {
          violations.push(`${path}: permanent root entry guard cannot be removed while the source exists`);
        }
      }
    }
    for (const [path, current] of Object.entries(currentFiles)) {
      const base =
        baseFiles[path] ??
        (section === 'rootDebtClosure' ? baseConfig.legacyAppShell.closure[path] : undefined);
      if (!base) continue;
      const currentView = {
        ...current,
        dependencyPaths: withoutSanctionedDependencies(desktopRoot, section, path, current.dependencyPaths),
      };
      const baseView = {
        ...base,
        dependencyPaths: withoutSanctionedDependencies(desktopRoot, section, path, base.dependencyPaths),
      };
      const metrics = section.endsWith('Closure') ? CAPABILITY_DEBT_METRICS : ROOT_DEBT_METRICS;
      for (const metric of metrics) {
        if (metricTotal(currentView[metric]) > metricTotal(baseView[metric])) {
          violations.push(`${path}: ${metric} debt increased from ${metricTotal(baseView[metric])} to ${metricTotal(currentView[metric])}`);
        }
        if (['bridgePaths', 'environmentCapabilities', 'hookCalls', 'lifecycleMethods'].includes(metric)) {
          const increases = Object.fromEntries(
            Object.entries(current[metric])
              .map(([key, count]) => [key, Math.max(0, count - (base[metric][key] ?? 0))])
              .filter(([, count]) => count > 0),
          );
          for (const [key, count] of Object.entries(increases)) {
            if (count > 0) {
              violations.push(`${path}: new or increased ${metric} debt ${key}`);
            }
          }
        }
        if (metric === 'actionFactories') {
          for (const factory of current.actionFactories) {
            if (!base.actionFactories.includes(factory)) violations.push(`${path}: new action factory debt ${factory}`);
          }
        }
        if (metric === 'dependencyPaths') {
          for (const [dependency, count] of Object.entries(currentView.dependencyPaths)) {
            if (
              count > (baseView.dependencyPaths[dependency] ?? 0) &&
              !allowsMigrationDependency({
                base: baseView,
                current: currentView,
                dependency,
                desktopRoot,
                path,
                section,
              })
            ) {
              violations.push(`${path}: new dependency debt ${dependency}`);
            }
          }
        }
      }
    }
  }
  const baseLegacyFiles = new Set(baseConfig.legacyRendererFiles);
  for (const path of config.legacyRendererFiles) {
    if (!baseLegacyFiles.has(path) && !isAllowedLegacyGrowthPath(config, path)) {
      violations.push(`${path}: new unclassified renderer source files are forbidden outside approved legacy directories`);
    }
  }
  const baseLegacyGrowthDirectories = new Set(baseConfig.legacyGrowthDirectories);
  for (const path of config.legacyGrowthDirectories) {
    if (!baseLegacyGrowthDirectories.has(path)) {
      violations.push(`${path}: new legacy growth directories are forbidden`);
    }
  }
  const baseLegacyFeatureImports = new Set(baseConfig.legacyFeatureImports);
  for (const edge of config.legacyFeatureImports) {
    if (!baseLegacyFeatureImports.has(edge)) violations.push(`${edge}: new feature-to-legacy imports are forbidden`);
  }
  const baseLegacyPlatformImports = new Set(baseConfig.legacyPlatformImports);
  for (const edge of config.legacyPlatformImports) {
    if (!baseLegacyPlatformImports.has(edge)) violations.push(`${edge}: new platform-to-legacy imports are forbidden`);
  }
}

export function checkRendererArchitecture({
  desktopRoot,
  config,
  baseConfig,
  enforceRendererEntryContract = true,
} = {}) {
  const resolvedDesktopRoot = resolve(desktopRoot ?? fileURLToPath(new URL('..', import.meta.url)));
  const resolvedConfig = config ?? JSON.parse(readFileSync(join(resolvedDesktopRoot, 'renderer-architecture.json'), 'utf8'));
  const violations = [];

  const currentConfigValid = validateArchitectureConfig(resolvedConfig, 'current', violations);
  const baseConfigValid = baseConfig ? validateArchitectureConfig(baseConfig, 'base', violations) : true;
  if (!currentConfigValid || !baseConfigValid) return violations.sort();
  if (enforceRendererEntryContract) {
    validateRendererEntryContract(resolvedDesktopRoot, resolvedConfig, violations);
  }
  validateLegacyLedger(resolvedDesktopRoot, resolvedConfig, violations);
  validateCopyCatalogFiles(resolvedDesktopRoot, violations);
  validateMonotonicDebt(resolvedConfig, baseConfig, resolvedDesktopRoot, violations);
  const allowedLegacyFeatureImports = new Set(resolvedConfig.legacyFeatureImports);
  const allowedLegacyPlatformImports = new Set(resolvedConfig.legacyPlatformImports);
  const observedLegacyFeatureImports = new Set();
  const observedLegacyPlatformImports = new Set();
  const sourceAnalyses = new Map();

  for (const scanRoot of ['src', 'stories', 'e2e']) {
    for (const file of sourceFiles(resolve(resolvedDesktopRoot, scanRoot))) {
      const fileRelative = normalizePath(relative(resolvedDesktopRoot, file));
      let analysis;
      try {
        analysis = analyzeRendererSource(readFileSync(file, 'utf8'), fileRelative);
      } catch (error) {
        violations.push(`${fileRelative}: could not parse source: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      sourceAnalyses.set(fileRelative, { analysis, file });
      validateStrictZone({ fileRelative, analysis, violations });
      validateDependencies({
        allowedLegacyFeatureImports,
        allowedLegacyPlatformImports,
        analysis,
        desktopRoot: resolvedDesktopRoot,
        file,
        fileRelative,
        observedLegacyFeatureImports,
        observedLegacyPlatformImports,
        violations,
      });
    }
  }

  validateControllerOwners({
    desktopRoot: resolvedDesktopRoot,
    config: resolvedConfig,
    sourceAnalyses,
    violations,
  });

  for (const edge of allowedLegacyFeatureImports) {
    if (!observedLegacyFeatureImports.has(edge)) violations.push(`${edge}: stale feature-to-legacy import budget`);
  }
  for (const edge of allowedLegacyPlatformImports) {
    if (!observedLegacyPlatformImports.has(edge)) violations.push(`${edge}: stale platform-to-legacy import budget`);
  }

  return violations.sort();
}

// The monotonic-debt ratchet must measure debt against what the base commit's
// source tree *actually* contained, not against the numbers its ledger happened
// to record. A ledger that under-reports its own tree (for example, one
// generated on a branch that predated files already merged into main) would
// otherwise make a faithful baseline correction look like brand-new debt and
// wedge the ledger permanently. We materialize the base tree and re-derive its
// debt, keeping the base ledger only as the source of policy fields (hook
// transitions, growth directories, root-debt key set, ownership).
function deriveBaseTreeConfig(repoRoot, desktopRoot, base, baseCommittedConfig) {
  const scratch = mkdtempSync(join(tmpdir(), 'renderer-arch-base-'));
  const worktreePath = join(scratch, 'tree');
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, base], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const baseDesktopRoot = resolve(worktreePath, relative(repoRoot, desktopRoot));
    return generateArchitectureConfig(baseDesktopRoot, baseCommittedConfig);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
    } catch {
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' });
      } catch {
        // Ignore prune failures; the scratch removal below is the real cleanup.
      }
    }
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of the scratch directory.
    }
  }
}

function loadBaseConfig(repoRoot, desktopRoot, base) {
  if (!base) return { baseConfig: undefined, introducedLedger: false };
  const relativeConfig = normalizePath(relative(repoRoot, join(desktopRoot, 'renderer-architecture.json')));
  try {
    execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error(`base ref does not resolve to a commit: ${base}`);
  }

  let source;
  try {
    source = execFileSync('git', ['show', `${base}:${relativeConfig}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    const diffStatus = execFileSync('git', ['diff', '--name-status', base, '--', relativeConfig], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const worktreeStatus = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all', '--', relativeConfig],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (diffStatus === `A\t${relativeConfig}` || worktreeStatus === `?? ${relativeConfig}`) {
      return { baseConfig: undefined, introducedLedger: true };
    }
    throw new Error(`base ledger is missing at ${base}:${relativeConfig}`);
  }

  let baseCommittedConfig;
  try {
    baseCommittedConfig = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `base ledger is invalid JSON at ${base}:${relativeConfig}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return {
      baseConfig: deriveBaseTreeConfig(repoRoot, desktopRoot, base, baseCommittedConfig),
      introducedLedger: false,
    };
  } catch (error) {
    // If the base tree cannot be materialized or analyzed (e.g. git worktree is
    // unavailable), fall back to the committed base ledger so the ratchet still
    // runs. This restores the pre-fix behavior rather than crashing the check.
    console.warn(
      `Renderer architecture check: could not derive base tree debt at ${base}; ` +
        `falling back to the committed base ledger. (${error instanceof Error ? error.message : String(error)})`,
    );
    return { baseConfig: baseCommittedConfig, introducedLedger: false };
  }
}

function parseCliArguments(args) {
  let base;
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--write' && !write) {
      write = true;
      continue;
    }
    if (argument === '--base' && base === undefined) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('usage: check-renderer-architecture.mjs [--write] [--base <commit>]');
      }
      base = value;
      index += 1;
      continue;
    }
    throw new Error('usage: check-renderer-architecture.mjs [--write] [--base <commit>]');
  }
  return { base, write };
}

function runCli() {
  const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const repoRoot = resolve(desktopRoot, '../..');
  let base;
  let config;
  let loadedBase;
  let write;
  try {
    ({ base, write } = parseCliArguments(process.argv.slice(2)));
    config = JSON.parse(readFileSync(join(desktopRoot, 'renderer-architecture.json'), 'utf8'));
    loadedBase = loadBaseConfig(repoRoot, desktopRoot, base);
    if (write) {
      config = generateArchitectureConfig(desktopRoot, config);
      writeFileSync(join(desktopRoot, 'renderer-architecture.json'), `${JSON.stringify(config, null, 2)}\n`);
      console.log('Renderer architecture ledger updated.');
    }
  } catch (error) {
    console.error(`Renderer architecture check could not start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const { baseConfig, introducedLedger } = loadedBase;
  const violations = checkRendererArchitecture({ baseConfig, config, desktopRoot });
  if (violations.length > 0) {
    console.error('Renderer architecture check failed:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  if (introducedLedger) {
    console.log(`Renderer architecture check passed; ${base} has no ledger and this change introduces it.`);
    return;
  }
  console.log(`Renderer architecture check passed${baseConfig ? ` against ${base}` : ''}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();

#!/usr/bin/env node
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

/**
 * Product lucide icons must pick a rung from ICON_SIZE, not a statically
 * provable raw pixel. Parse TSX so comments and unrelated components with a
 * numeric size prop do not become false positives while aliases, derived icon
 * collections, constant expressions, and props-object spreads remain governed.
 */
import { globSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const root = fileURLToPath(new URL('..', import.meta.url));
const GLOBS = [
  'packages/ui/src/**/*.{ts,tsx}',
  'packages/ui/stories/**/*.{ts,tsx}',
  'apps/desktop/src/**/*.{ts,tsx}',
];
const ICON_METADATA_EXPORTS = new Set(['ICON_SIZE', 'LucideIcon', 'LucideProps']);
const NUMERIC_SIZE_STRING = /^[+-]?(?:\d+|\d*\.\d+)$/;

function normalizedRelativePath(repoRoot, file) {
  return relative(repoRoot, file).split('\\').join('/');
}

function withoutModuleExtension(path) {
  return path.replace(/\.(?:m?[jt]sx?)$/u, '');
}

function isIconSeamSpecifier(specifier, file, repoRoot) {
  if (specifier === '@maka/ui/icons') return true;
  if (!specifier.startsWith('.')) return false;
  return (
    withoutModuleExtension(resolve(dirname(file), specifier)) ===
    resolve(repoRoot, 'packages/ui/src/icons')
  );
}

function unwrapExpression(expression) {
  if (
    expression.type === 'ParenthesizedExpression' ||
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSTypeAssertion' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression'
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function isStaticRawSize(expression, scope) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === 'NumericLiteral') return true;
  if (unwrapped.type === 'StringLiteral') {
    return NUMERIC_SIZE_STRING.test(unwrapped.value.trim());
  }
  if (unwrapped.type === 'TemplateLiteral' && unwrapped.expressions.length === 0) {
    return NUMERIC_SIZE_STRING.test(unwrapped.quasis[0]?.value.cooked?.trim() ?? '');
  }
  if (unwrapped.type === 'Identifier') {
    return resolveBinding(scope, unwrapped.name) === 'raw-size';
  }
  if (
    unwrapped.type === 'MemberExpression' &&
    !unwrapped.computed &&
    unwrapped.property.type === 'Identifier'
  ) {
    const object = inferExpressionValue(unwrapped.object, scope);
    return (
      object?.kind === 'record' && object.properties.get(unwrapped.property.name) === 'raw-size'
    );
  }
  if (
    unwrapped.type === 'UnaryExpression' &&
    (unwrapped.operator === '+' || unwrapped.operator === '-')
  ) {
    return isStaticRawSize(unwrapped.argument, scope);
  }
  if (
    unwrapped.type === 'BinaryExpression' &&
    ['+', '-', '*', '/', '%', '**'].includes(unwrapped.operator)
  ) {
    return isStaticRawSize(unwrapped.left, scope) && isStaticRawSize(unwrapped.right, scope);
  }
  if (unwrapped.type === 'ConditionalExpression') {
    return (
      isStaticRawSize(unwrapped.consequent, scope) && isStaticRawSize(unwrapped.alternate, scope)
    );
  }
  return false;
}

function propertyName(property) {
  if (property.type === 'Identifier' || property.type === 'StringLiteral')
    return property.name ?? property.value;
  return undefined;
}

function mergeValueKinds(values) {
  const present = values.filter((value) => value !== 'empty' && value !== 'unknown');
  if (present.length === 0) return values.includes('empty') ? 'empty' : 'unknown';
  if (present.every((value) => value === present[0])) return present[0];
  if (present.every((value) => value?.kind === 'collection')) {
    return {
      kind: 'collection',
      element: mergeValueKinds(present.map((value) => value.element)),
    };
  }
  return 'unknown';
}

function inferExpressionValue(expression, scope) {
  const unwrapped = unwrapExpression(expression);
  if (isStaticRawSize(unwrapped, scope)) return 'raw-size';
  if (unwrapped.type === 'Identifier') return resolveBinding(scope, unwrapped.name);
  if (unwrapped.type === 'MemberExpression') {
    const object = inferExpressionValue(unwrapped.object, scope);
    if (!unwrapped.computed && unwrapped.property.type === 'Identifier' && object === 'namespace') {
      return ICON_METADATA_EXPORTS.has(unwrapped.property.name) ? 'not-icon' : 'icon';
    }
    if (object?.kind === 'record') {
      if (!unwrapped.computed && unwrapped.property.type === 'Identifier') {
        return object.properties.get(unwrapped.property.name) ?? 'unknown';
      }
      if (unwrapped.computed && unwrapped.property.type === 'StringLiteral') {
        return object.properties.get(unwrapped.property.value) ?? 'unknown';
      }
      const values = [...object.properties.values()];
      if (object.closed && values.length > 0 && values.every((value) => value === 'icon')) {
        return 'icon';
      }
    }
  }
  if (unwrapped.type === 'ConditionalExpression') {
    return mergeValueKinds([
      inferExpressionValue(unwrapped.consequent, scope),
      inferExpressionValue(unwrapped.alternate, scope),
    ]);
  }
  if (unwrapped.type === 'ObjectExpression') {
    const properties = new Map();
    let closed = true;
    for (const property of unwrapped.properties) {
      if (property.type !== 'ObjectProperty' || property.computed) {
        closed = false;
        continue;
      }
      const name = propertyName(property.key);
      if (name === undefined) {
        closed = false;
        continue;
      }
      properties.set(name, inferExpressionValue(property.value, scope));
    }
    return { kind: 'record', properties, closed };
  }
  if (unwrapped.type === 'ArrayExpression') {
    const elements = unwrapped.elements
      .filter((element) => element && element.type !== 'SpreadElement')
      .map((element) => inferExpressionValue(element, scope));
    return { kind: 'collection', element: mergeValueKinds(elements) };
  }
  if (unwrapped.type === 'CallExpression') {
    return inferCallResult(unwrapped, scope);
  }
  return 'unknown';
}

function createScope(parent = null) {
  return { parent, names: new Map() };
}

function defineBinding(scope, name, kind) {
  scope.names.set(name, kind);
}

function resolveBinding(scope, name) {
  for (let current = scope; current; current = current.parent) {
    if (current.names.has(name)) return current.names.get(name);
  }
  return 'unbound';
}

function patternNames(pattern, names = []) {
  if (!pattern) return names;
  if (pattern.type === 'Identifier') {
    names.push(pattern.name);
    return names;
  }
  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left, names);
  if (pattern.type === 'RestElement') return patternNames(pattern.argument, names);
  if (pattern.type === 'TSParameterProperty') return patternNames(pattern.parameter, names);
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) patternNames(element, names);
    return names;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') patternNames(property.argument, names);
      else patternNames(property.value, names);
    }
  }
  return names;
}

function bindPattern(scope, pattern, value = 'not-icon') {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    defineBinding(scope, pattern.name, value);
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    bindPattern(scope, pattern.left, value);
    return;
  }
  if (pattern.type === 'RestElement') {
    bindPattern(scope, pattern.argument, 'not-icon');
    return;
  }
  if (pattern.type === 'TSParameterProperty') {
    bindPattern(scope, pattern.parameter, value);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element, index) => {
      const elementValue = value?.kind === 'tuple' ? value.elements[index] : 'not-icon';
      bindPattern(scope, element, elementValue ?? 'not-icon');
    });
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') {
        bindPattern(scope, property.argument, 'not-icon');
        continue;
      }
      const name = property.computed ? undefined : propertyName(property.key);
      const propertyValue =
        value?.kind === 'record' && name !== undefined
          ? (value.properties.get(name) ?? 'unknown')
          : 'not-icon';
      bindPattern(scope, property.value, propertyValue);
    }
  }
}

function isFunctionNode(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod' ||
    node.type === 'ObjectMethod'
  );
}

function childEntries(node) {
  const entries = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'range') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && typeof child.type === 'string') {
          entries.push(child);
        }
      }
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      entries.push(value);
    }
  }
  return entries;
}

function bindParams(scope, node, values = []) {
  const params = node.params ?? [];
  params.forEach((param, index) => bindPattern(scope, param, values[index] ?? 'not-icon'));
  if (node.id?.type === 'Identifier') defineBinding(scope, node.id.name, 'not-icon');
}

function rawSizeExpressionForAttribute(attribute, scope) {
  if (
    attribute.type !== 'JSXAttribute' ||
    attribute.name.type !== 'JSXIdentifier' ||
    attribute.name.name !== 'size' ||
    !attribute.value
  ) {
    return undefined;
  }
  if (attribute.value.type === 'StringLiteral') {
    return NUMERIC_SIZE_STRING.test(attribute.value.value.trim()) ? attribute : undefined;
  }
  return attribute.value.type === 'JSXExpressionContainer' &&
    attribute.value.expression.type !== 'JSXEmptyExpression' &&
    isStaticRawSize(attribute.value.expression, scope)
    ? attribute
    : undefined;
}

function rawSizeExpressionForSpread(attribute, scope) {
  if (attribute.type !== 'JSXSpreadAttribute') return undefined;
  const value = inferExpressionValue(attribute.argument, scope);
  return value?.kind === 'record' && value.properties.get('size') === 'raw-size'
    ? attribute
    : undefined;
}

function importedName(specifier) {
  if (specifier.imported.type === 'Identifier') return specifier.imported.name;
  return specifier.imported.value;
}

function bindIconImports(program, file, repoRoot, scope) {
  for (const statement of program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type' ||
      !isIconSeamSpecifier(statement.source.value, file, repoRoot)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        defineBinding(scope, specifier.local.name, 'namespace');
      } else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
        const exportedName = importedName(specifier);
        if (!ICON_METADATA_EXPORTS.has(exportedName)) {
          defineBinding(scope, specifier.local.name, 'icon');
        }
      }
    }
  }
}

function functionReturnValue(node, parentScope, parameterValues) {
  const scope = createScope(parentScope);
  bindParams(scope, node, parameterValues);
  if (node.body.type !== 'BlockStatement') return inferExpressionValue(node.body, scope);
  const values = [];
  const visit = (child) => {
    if (!child || typeof child !== 'object' || typeof child.type !== 'string') return;
    if (child !== node && isFunctionNode(child)) return;
    if (child.type === 'ReturnStatement' && child.argument) {
      values.push(inferExpressionValue(child.argument, scope));
      return;
    }
    for (const descendant of childEntries(child)) visit(descendant);
  };
  visit(node.body);
  return mergeValueKinds(values);
}

function collectionCallbackValues(call, scope) {
  if (
    call.callee.type !== 'MemberExpression' ||
    call.callee.computed ||
    call.callee.property.type !== 'Identifier' ||
    !['map', 'flatMap', 'filter', 'sort'].includes(call.callee.property.name)
  ) {
    return undefined;
  }
  const collection = inferExpressionValue(call.callee.object, scope);
  if (collection?.kind !== 'collection') return undefined;
  return [collection.element, 'not-icon', 'not-icon'];
}

function inferCallResult(call, scope) {
  if (
    call.callee.type === 'MemberExpression' &&
    !call.callee.computed &&
    call.callee.object.type === 'Identifier' &&
    call.callee.object.name === 'Object' &&
    call.callee.property.type === 'Identifier' &&
    call.callee.property.name === 'entries' &&
    call.arguments.length > 0 &&
    call.arguments[0].type !== 'SpreadElement' &&
    inferExpressionValue(call.arguments[0], scope) === 'namespace'
  ) {
    return {
      kind: 'collection',
      element: { kind: 'tuple', elements: ['not-icon', 'icon'] },
    };
  }
  if (
    call.callee.type !== 'MemberExpression' ||
    call.callee.computed ||
    call.callee.property.type !== 'Identifier'
  ) {
    return 'unknown';
  }
  const receiver = inferExpressionValue(call.callee.object, scope);
  if (receiver?.kind !== 'collection') return 'unknown';
  const method = call.callee.property.name;
  if (method === 'filter' || method === 'sort') return receiver;
  if (method !== 'map' && method !== 'flatMap') return 'unknown';
  const callback = call.arguments[0];
  if (!callback || callback.type === 'SpreadElement' || !isFunctionNode(callback)) {
    return 'unknown';
  }
  const returned = functionReturnValue(callback, scope, [receiver.element, 'not-icon', 'not-icon']);
  if (method === 'flatMap' && returned?.kind === 'collection') return returned;
  return { kind: 'collection', element: returned };
}

function isGovernedIconTag(tagName, scope) {
  if (tagName.type === 'JSXIdentifier') {
    return resolveBinding(scope, tagName.name) === 'icon';
  }
  return (
    tagName.type === 'JSXMemberExpression' &&
    tagName.object.type === 'JSXIdentifier' &&
    tagName.property.type === 'JSXIdentifier' &&
    resolveBinding(scope, tagName.object.name) === 'namespace' &&
    !ICON_METADATA_EXPORTS.has(tagName.property.name)
  );
}

function collectHits(node, scope, sourceText, file, hits, parameterValues) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;

  if (isFunctionNode(node)) {
    const inner = createScope(scope);
    bindParams(inner, node, parameterValues);
    for (const child of childEntries(node)) collectHits(child, inner, sourceText, file, hits);
    return;
  }

  if (node.type === 'CallExpression') {
    const callbackValues = collectionCallbackValues(node, scope);
    for (const child of childEntries(node)) {
      const isCallback = callbackValues && node.arguments.includes(child) && isFunctionNode(child);
      collectHits(child, scope, sourceText, file, hits, isCallback ? callbackValues : undefined);
    }
    return;
  }

  if (node.type === 'CatchClause') {
    const inner = createScope(scope);
    for (const name of patternNames(node.param)) defineBinding(inner, name, 'not-icon');
    collectHits(node.body, inner, sourceText, file, hits);
    return;
  }

  if (node.type === 'BlockStatement') {
    const inner = createScope(scope);
    for (const child of node.body) collectHits(child, inner, sourceText, file, hits);
    return;
  }

  if (
    node.type === 'ForStatement' ||
    node.type === 'ForInStatement' ||
    node.type === 'ForOfStatement'
  ) {
    const inner = createScope(scope);
    for (const child of childEntries(node)) collectHits(child, inner, sourceText, file, hits);
    return;
  }

  if (node.type === 'VariableDeclarator') {
    if (node.init) collectHits(node.init, scope, sourceText, file, hits);
    if (node.id.type === 'Identifier') {
      defineBinding(
        scope,
        node.id.name,
        node.init ? inferExpressionValue(node.init, scope) : 'not-icon',
      );
    } else {
      for (const name of patternNames(node.id)) defineBinding(scope, name, 'not-icon');
    }
    return;
  }

  if (node.type === 'JSXOpeningElement' && isGovernedIconTag(node.name, scope)) {
    for (const attribute of node.attributes) {
      const violation =
        rawSizeExpressionForAttribute(attribute, scope) ??
        rawSizeExpressionForSpread(attribute, scope);
      if (!violation) continue;
      hits.push({
        file,
        line: violation.loc.start.line,
        column: violation.loc.start.column + 1,
        expression: sourceText.slice(violation.start, violation.end),
      });
    }
  }

  for (const child of childEntries(node)) collectHits(child, scope, sourceText, file, hits);
}

export function findRawIconSizes(sourceText, file, options = {}) {
  const repoRoot = options.repoRoot ?? root;
  const program = parse(sourceText, {
    sourceType: 'module',
    sourceFilename: file,
    plugins: ['typescript', 'jsx'],
  }).program;
  const moduleScope = createScope();
  bindIconImports(program, file, repoRoot, moduleScope);
  const hits = [];
  collectHits(program, moduleScope, sourceText, normalizedRelativePath(repoRoot, file), hits);
  return hits;
}

export function scanIconSizes(repoRoot = root) {
  const hits = [];
  for (const pattern of GLOBS) {
    for (const relativeFile of globSync(pattern, { cwd: repoRoot })) {
      const file = resolve(repoRoot, relativeFile);
      hits.push(...findRawIconSizes(readFileSync(file, 'utf8'), file, { repoRoot }));
    }
  }
  return hits;
}

function run() {
  const hits = scanIconSizes();
  if (hits.length > 0) {
    console.error(
      `icon sizes must use ICON_SIZE (meta/control/chrome/empty/plate):\n${hits
        .map((hit) => `  ${hit.file}:${hit.line}:${hit.column} ${hit.expression}`)
        .join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('icon size scale: ok');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) run();

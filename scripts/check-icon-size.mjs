#!/usr/bin/env node
/**
 * Product lucide icons must pick a rung from ICON_SIZE, not a raw pixel.
 * Parse TSX so comments and unrelated components with a numeric size prop do
 * not become false positives while aliases and non-integer literals remain
 * governed.
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

function isNumericConstant(expression) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === 'NumericLiteral') return true;
  return (
    unwrapped.type === 'UnaryExpression' &&
    (unwrapped.operator === '+' || unwrapped.operator === '-') &&
    unwrapExpression(unwrapped.argument).type === 'NumericLiteral'
  );
}

function isKnownIconValue(expression, scope) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === 'Identifier') return resolveBinding(scope, unwrapped.name) === 'icon';
  if (
    unwrapped.type === 'MemberExpression' &&
    !unwrapped.computed &&
    unwrapped.object.type === 'Identifier' &&
    unwrapped.property.type === 'Identifier'
  ) {
    return (
      resolveBinding(scope, unwrapped.object.name) === 'namespace' &&
      !ICON_METADATA_EXPORTS.has(unwrapped.property.name)
    );
  }
  if (unwrapped.type === 'ConditionalExpression') {
    return isKnownIconValue(unwrapped.consequent, scope) && isKnownIconValue(unwrapped.alternate, scope);
  }
  return false;
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

function bindParams(scope, node) {
  const params = node.params ?? [];
  for (const param of params) {
    for (const name of patternNames(param)) defineBinding(scope, name, 'not-icon');
  }
  if (node.id?.type === 'Identifier') defineBinding(scope, node.id.name, 'not-icon');
}

function isNumericSizeAttribute(attribute) {
  if (
    attribute.type !== 'JSXAttribute' ||
    attribute.name.type !== 'JSXIdentifier' ||
    attribute.name.name !== 'size' ||
    !attribute.value
  ) {
    return false;
  }
  if (attribute.value.type === 'StringLiteral') {
    return NUMERIC_SIZE_STRING.test(attribute.value.value.trim());
  }
  return (
    attribute.value.type === 'JSXExpressionContainer' &&
    attribute.value.expression.type !== 'JSXEmptyExpression' &&
    isNumericConstant(attribute.value.expression)
  );
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

function collectHits(node, scope, sourceText, file, hits) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;

  if (isFunctionNode(node)) {
    const inner = createScope(scope);
    bindParams(inner, node);
    for (const child of childEntries(node)) collectHits(child, inner, sourceText, file, hits);
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
      defineBinding(scope, node.id.name, node.init && isKnownIconValue(node.init, scope) ? 'icon' : 'not-icon');
    } else {
      for (const name of patternNames(node.id)) defineBinding(scope, name, 'not-icon');
    }
    return;
  }

  if (node.type === 'JSXOpeningElement' && isGovernedIconTag(node.name, scope)) {
    for (const attribute of node.attributes) {
      if (!isNumericSizeAttribute(attribute)) continue;
      hits.push({
        file,
        line: attribute.loc.start.line,
        column: attribute.loc.start.column + 1,
        expression: sourceText.slice(attribute.start, attribute.end),
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

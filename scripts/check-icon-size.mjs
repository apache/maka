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
const DYNAMIC_ICON_TAGS = new Map([['packages/ui/stories/icons.stories.tsx', new Set(['Comp'])]]);

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

function isKnownIconValue(expression, iconBindings, iconNamespaces) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === 'Identifier') return iconBindings.has(unwrapped.name);
  if (
    unwrapped.type === 'MemberExpression' &&
    !unwrapped.computed &&
    unwrapped.object.type === 'Identifier' &&
    unwrapped.property.type === 'Identifier'
  ) {
    return (
      iconNamespaces.has(unwrapped.object.name) &&
      !ICON_METADATA_EXPORTS.has(unwrapped.property.name)
    );
  }
  if (unwrapped.type === 'ConditionalExpression') {
    return (
      isKnownIconValue(unwrapped.consequent, iconBindings, iconNamespaces) &&
      isKnownIconValue(unwrapped.alternate, iconBindings, iconNamespaces)
    );
  }
  return false;
}

function visitAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visitAst(child, visit);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      visitAst(value, visit);
    }
  }
}

function importedName(specifier) {
  if (specifier.imported.type === 'Identifier') return specifier.imported.name;
  return specifier.imported.value;
}

function collectIconBindings(program, file, repoRoot) {
  const iconBindings = new Set();
  const iconNamespaces = new Set();
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
        iconNamespaces.add(specifier.local.name);
      } else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
        const exportedName = importedName(specifier);
        if (!ICON_METADATA_EXPORTS.has(exportedName)) {
          iconBindings.add(specifier.local.name);
        }
      }
    }
  }

  // Preserve simple aliases used to select one of several imported icons.
  let changed = true;
  while (changed) {
    changed = false;
    visitAst(program, (node) => {
      if (
        node.type === 'VariableDeclarator' &&
        node.id.type === 'Identifier' &&
        node.init &&
        !iconBindings.has(node.id.name) &&
        isKnownIconValue(node.init, iconBindings, iconNamespaces)
      ) {
        iconBindings.add(node.id.name);
        changed = true;
      }
    });
  }
  return { iconBindings, iconNamespaces };
}

function isGovernedIconTag(tagName, iconBindings, iconNamespaces, dynamicIconTags) {
  if (tagName.type === 'JSXIdentifier') {
    return iconBindings.has(tagName.name) || dynamicIconTags.has(tagName.name);
  }
  return (
    tagName.type === 'JSXMemberExpression' &&
    tagName.object.type === 'JSXIdentifier' &&
    tagName.property.type === 'JSXIdentifier' &&
    iconNamespaces.has(tagName.object.name) &&
    !ICON_METADATA_EXPORTS.has(tagName.property.name)
  );
}

export function findRawIconSizes(sourceText, file, options = {}) {
  const repoRoot = options.repoRoot ?? root;
  const program = parse(sourceText, {
    sourceType: 'module',
    sourceFilename: file,
    plugins: ['typescript', 'jsx'],
  }).program;
  const { iconBindings, iconNamespaces } = collectIconBindings(program, file, repoRoot);
  const dynamicIconTags =
    DYNAMIC_ICON_TAGS.get(normalizedRelativePath(repoRoot, file)) ?? new Set();
  const hits = [];
  visitAst(program, (node) => {
    if (
      node.type === 'JSXOpeningElement' &&
      isGovernedIconTag(node.name, iconBindings, iconNamespaces, dynamicIconTags)
    ) {
      for (const attribute of node.attributes) {
        if (
          attribute.type !== 'JSXAttribute' ||
          attribute.name.type !== 'JSXIdentifier' ||
          attribute.name.name !== 'size' ||
          attribute.value?.type !== 'JSXExpressionContainer' ||
          attribute.value.expression.type === 'JSXEmptyExpression' ||
          !isNumericConstant(attribute.value.expression)
        ) {
          continue;
        }
        hits.push({
          file: normalizedRelativePath(repoRoot, file),
          line: attribute.loc.start.line,
          column: attribute.loc.start.column + 1,
          expression: sourceText.slice(attribute.start, attribute.end),
        });
      }
    }
  });
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

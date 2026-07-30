import assert from 'node:assert/strict';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const sourceRoot = join(process.cwd(), 'src');
const authorityEntrypoint = join(sourceRoot, 'root-authority.ts');
const compilerApi = new API({ cwd: process.cwd() });
const projectConfig = join(process.cwd(), 'tsconfig.json');
const compilerSnapshot = compilerApi.updateSnapshot({ openProjects: [projectConfig] });
const compilerProject = loadCompilerProject();
const allowedAuthorityLocalModules = new Set(['marker-file.ts', 'root-authority.ts']);
const allowedAuthorityExternalImports = new Set([
  'fs-native-extensions',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:path',
]);

async function dependencyScannerFixture(target: string): Promise<void> {
  await import(`node:url`);
  await import(target);
}
void dependencyScannerFixture;

function dependencyScannerLoaderCapabilityFixture(): void {
  const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);
  load('@maka/runtime');
}
void dependencyScannerLoaderCapabilityFixture;

after(() => {
  compilerSnapshot.dispose();
  compilerApi.close();
});

function loadCompilerProject() {
  const project = compilerSnapshot.getProject(projectConfig);
  if (!project) throw new Error(`TypeScript did not load ${projectConfig}`);
  return project;
}

test('root authority cannot transitively reach domain Stores or Runtime composition', () => {
  const violations: string[] = [];
  for (const path of reachableModules(authorityEntrypoint)) {
    const localPath = relative(sourceRoot, path);
    if (
      !allowedAuthorityLocalModules.has(localPath) &&
      !localPath.startsWith(`root-authority${sep}`)
    ) {
      violations.push(`root authority reaches ${localPath}`);
    }
    for (const specifier of moduleSpecifiers(path)) {
      if (isRelativeSpecifier(specifier)) {
        const target = sourcePathForSpecifier(path, specifier);
        if (!isInside(sourceRoot, target)) violations.push(`${localPath}: ${specifier}`);
        continue;
      }
      if (allowedAuthorityExternalImports.has(specifier)) continue;
      violations.push(`${localPath}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('dependency scanning fails closed on computed loads, loader aliases, and unapproved packages', () => {
  const scan = scanModuleReferences(
    join(sourceRoot, '__tests__', 'root-authority-dependency.test.ts'),
  );
  assert.ok(scan.specifiers.includes('node:url'));
  assert.equal(scan.specifiers.includes('node:module'), false);
  assert.equal(allowedAuthorityExternalImports.has('node:module'), false);
  assert.equal(allowedAuthorityExternalImports.has('@maka/runtime'), false);
  assert.equal(scan.nonStaticLoads.length, 1);
  assert.match(scan.nonStaticLoads[0] ?? '', /import\(\.\.\.\)/);
  assert.equal(scan.forbiddenLoaderCapabilities.length, 1);
  assert.match(scan.forbiddenLoaderCapabilities[0] ?? '', /getBuiltinModule/);
});

function reachableModules(entrypoint: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of moduleSpecifiers(path)) {
      if (!isRelativeSpecifier(specifier)) continue;
      const target = sourcePathForSpecifier(path, specifier);
      if (isInside(sourceRoot, target)) visit(target);
    }
  };
  visit(entrypoint);
  return [...seen];
}

function moduleSpecifiers(path: string): string[] {
  const scan = scanModuleReferences(path);
  const violations = [...scan.nonStaticLoads, ...scan.forbiddenLoaderCapabilities];
  if (violations.length > 0) {
    throw new Error(
      `Dependency boundary requires explicit module declarations:\n${violations.join('\n')}`,
    );
  }
  return scan.specifiers;
}

function scanModuleReferences(path: string): {
  specifiers: string[];
  nonStaticLoads: string[];
  forbiddenLoaderCapabilities: string[];
} {
  const source = compilerProject.program.getSourceFile(path);
  if (!source) throw new Error(`TypeScript did not load ${path}`);
  const specifiers: string[] = [];
  const nonStaticLoads: string[] = [];
  const forbiddenLoaderCapabilities: string[] = [];
  const visit = (node: ts.Node) => {
    if (forbiddenLoaderCapabilities.length === 0 && isGetBuiltinModuleAccess(node)) {
      forbiddenLoaderCapabilities.push(`${path}: getBuiltinModule`);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const target = node.arguments[0];
      if (target && ts.isStringLiteralLikeNode(target)) specifiers.push(target.text);
      else
        nonStaticLoads.push(
          `${path}: ${node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require'}(...)`,
        );
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return { specifiers, nonStaticLoads, forbiddenLoaderCapabilities };
}

function isGetBuiltinModuleAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'getBuiltinModule';
  if (ts.isElementAccessExpression(node)) {
    return Boolean(
      node.argumentExpression &&
        ts.isStringLiteralLikeNode(node.argumentExpression) &&
        node.argumentExpression.text === 'getBuiltinModule',
    );
  }
  return ts.isIdentifier(node) && node.text === 'getBuiltinModule';
}

function sourcePathForSpecifier(importer: string, specifier: string): string {
  const target = resolve(dirname(importer), specifier);
  if (target.endsWith('.js')) return `${target.slice(0, -3)}.ts`;
  return target.endsWith('.ts') ? target : `${target}.ts`;
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}

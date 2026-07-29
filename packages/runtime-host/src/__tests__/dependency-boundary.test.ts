import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const sourceRoot = join(process.cwd(), 'src');
const packageName = '@maka/runtime-host';
const compilerApi = new API({ cwd: process.cwd() });
const projectConfig = join(process.cwd(), 'tsconfig.json');
const compilerSnapshot = compilerApi.updateSnapshot({ openProjects: [projectConfig] });
const compilerProject = loadCompilerProject();
const allowedHostExternalImports = new Set([
  '@maka/storage/root-authority',
  'node:child_process',
  'node:crypto',
  'node:fs/promises',
  'node:net',
  'node:path',
  'node:perf_hooks',
  'node:url',
  'node:util',
]);
const allowedServerExternalImports = new Set([
  ...allowedHostExternalImports,
  '@maka/core/agent-run',
  '@maka/core/artifacts',
  '@maka/core/backend-types',
  '@maka/core/events',
  '@maka/core/interaction',
  '@maka/core/local-memory',
  '@maka/core/redaction',
  '@maka/core/runtime-policy',
  '@maka/core/runtime-event',
  '@maka/core/session',
  '@maka/core/task-ledger',
  '@maka/core/usage-stats/types',
  '@maka/runtime',
  '@maka/storage/agent-graph-control-store',
  '@maka/storage/artifact-stores',
  '@maka/storage/execution-stores',
  '@maka/storage/interaction-store',
  '@maka/storage/memory-bundle-store',
  '@maka/storage/runtime-policy-stores',
  '@maka/storage/task-ledger-authority',
  '@maka/storage/usage-stores',
  'node:async_hooks',
]);
const allowedExternalImports = {
  client: allowedHostExternalImports,
  protocol: new Set([
    '@maka/core/attachments',
    '@maka/core/artifacts',
    '@maka/core/events',
    '@maka/core/interaction',
    '@maka/core/local-memory',
    '@maka/core/runtime-policy',
    '@maka/core/task-ledger',
    '@maka/core/usage-stats/pricing',
    '@maka/core/usage-stats/types',
    'node:util',
  ]),
} as const;

async function dependencyScannerFixture(target: string): Promise<void> {
  await import(`node:url`);
  await import(target);
}
void dependencyScannerFixture;

function dependencyScannerLoaderCapabilityFixture(): void {
  const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);
  load('@maka/headless');
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

test('protocol and client stay within their subpaths and the root-authority boundary', async () => {
  const violations: string[] = [];
  const publicEntrypoints = await readPublicEntrypoints();
  for (const area of ['protocol', 'client'] as const) {
    const entrypoint = publicEntrypoints.get(area);
    assert.ok(entrypoint, `missing public ${area} entrypoint`);
    for (const path of reachableModules(entrypoint, publicEntrypoints)) {
      const localPath = relative(sourceRoot, path);
      const topLevelArea = localPath.split(sep)[0];
      if (
        localPath === 'candidate-main.ts' ||
        topLevelArea === 'server' ||
        (area === 'protocol' && topLevelArea !== 'protocol')
      ) {
        violations.push(`${area} reaches ${localPath}`);
      }
      for (const specifier of moduleSpecifiers(path)) {
        const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
        if (target) {
          if (!isInside(sourceRoot, target)) violations.push(`${path}: ${specifier}`);
          continue;
        }
        const allowedImports =
          topLevelArea === 'protocol'
            ? allowedExternalImports.protocol
            : allowedExternalImports[area];
        if (!allowedImports.has(specifier)) violations.push(`${path}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('only the server subgraph can reach the M2 Runtime composition', async () => {
  const violations: string[] = [];
  for (const path of await listTypeScriptFiles(sourceRoot)) {
    const localPath = relative(sourceRoot, path);
    const topLevelArea = localPath.split(sep)[0];
    if (topLevelArea === '__tests__') continue;
    const allowedImports =
      topLevelArea === 'server' || localPath === 'candidate-main.ts'
        ? allowedServerExternalImports
        : topLevelArea === 'protocol'
          ? allowedExternalImports.protocol
          : allowedHostExternalImports;
    for (const specifier of moduleSpecifiers(path)) {
      if (isRelativeSpecifier(specifier)) {
        const target = sourcePathForSpecifier(path, specifier);
        if (!isInside(sourceRoot, target)) violations.push(`${path}: ${specifier}`);
        continue;
      }
      if (!allowedImports.has(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the production Candidate dependency graph remains non-serving', () => {
  const publicEntrypoints = new Map<string, string>();
  const reached = reachableModules(join(sourceRoot, 'candidate-main.ts'), publicEntrypoints);
  const forbiddenLocalModules = new Set([
    'server/execution-candidate.ts',
    'server/execution-composition.ts',
    'server/root-turn-coordinator.ts',
    'server/memory-coordinator.ts',
    'server/memory-projection.ts',
    'server/runtime-policy-coordinator.ts',
    'server/session-continuity-coordinator.ts',
    'server/task-ledger-coordinator.ts',
  ]);
  const violations: string[] = [];
  for (const path of reached) {
    const localPath = relative(sourceRoot, path);
    if (forbiddenLocalModules.has(localPath)) violations.push(localPath);
    for (const specifier of moduleSpecifiers(path)) {
      if (
        specifier === '@maka/runtime' ||
        specifier === '@maka/storage/agent-graph-control-store' ||
        specifier === '@maka/storage/execution-stores' ||
        specifier === '@maka/storage/memory-bundle-store' ||
        specifier === '@maka/storage/runtime-policy-stores' ||
        specifier === '@maka/storage/task-ledger-authority'
      ) {
        violations.push(`${localPath}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the public server entrypoint does not expose the test execution composition', async () => {
  const publicEntrypoints = await readPublicEntrypoints();
  const serverEntrypoint = publicEntrypoints.get('server');
  assert.ok(serverEntrypoint, 'missing public server entrypoint');
  const forbidden = new Set([
    'server/execution-candidate.ts',
    'server/execution-composition.ts',
    'server/memory-coordinator.ts',
    'server/memory-projection.ts',
    'server/root-turn-coordinator.ts',
    'server/session-continuity-coordinator.ts',
  ]);
  assert.deepEqual(
    reachableModules(serverEntrypoint, publicEntrypoints)
      .map((path) => relative(sourceRoot, path))
      .filter((path) => forbidden.has(path))
      .sort(),
    [],
  );
});

test('dependency scanning fails closed on computed loads, loader aliases, and unapproved packages', () => {
  const scan = scanModuleReferences(join(sourceRoot, '__tests__', 'dependency-boundary.test.ts'));
  assert.ok(scan.specifiers.includes('node:url'));
  assert.equal(scan.specifiers.includes('node:module'), false);
  assert.equal(allowedHostExternalImports.has('node:module'), false);
  assert.equal(allowedHostExternalImports.has('@maka/headless'), false);
  assert.equal(scan.nonStaticLoads.length, 1);
  assert.match(scan.nonStaticLoads[0] ?? '', /import\(\.\.\.\)/);
  assert.equal(scan.forbiddenLoaderCapabilities.length, 1);
  assert.match(scan.forbiddenLoaderCapabilities[0] ?? '', /getBuiltinModule/);
});

function reachableModules(
  entrypoint: string,
  publicEntrypoints: ReadonlyMap<string, string>,
): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of moduleSpecifiers(path)) {
      const target = sourcePathForLocalSpecifier(path, specifier, publicEntrypoints);
      if (!target) continue;
      if (isInside(sourceRoot, target)) visit(target);
    }
  };
  visit(entrypoint);
  return [...seen];
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
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

function sourcePathForLocalSpecifier(
  importer: string,
  specifier: string,
  publicEntrypoints: ReadonlyMap<string, string>,
): string | undefined {
  if (isRelativeSpecifier(specifier)) return sourcePathForSpecifier(importer, specifier);
  if (!specifier.startsWith(`${packageName}/`)) return undefined;
  return publicEntrypoints.get(specifier.slice(packageName.length + 1));
}

async function readPublicEntrypoints(): Promise<Map<string, string>> {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    name?: unknown;
    exports?: Record<string, unknown>;
  };
  assert.equal(manifest.name, packageName);
  const entrypoints = new Map<string, string>();
  for (const area of ['protocol', 'client', 'server']) {
    const target = manifest.exports?.[`./${area}`];
    if (typeof target !== 'string') throw new Error(`missing ${packageName}/${area} export`);
    assert.match(target, /^\.\/dist\/.+\.js$/, `invalid ${packageName}/${area} export target`);
    const sourcePath = resolve(sourceRoot, target.slice('./dist/'.length).replace(/\.js$/, '.ts'));
    assert.ok(
      isInside(sourceRoot, sourcePath),
      `${packageName}/${area} export escapes the package source`,
    );
    entrypoints.set(area, sourcePath);
  }
  return entrypoints;
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.');
}

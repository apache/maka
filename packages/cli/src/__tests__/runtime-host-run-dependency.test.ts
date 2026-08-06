import assert from 'node:assert/strict';
import { dirname, join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const packageRoot = resolve(sourceRoot, '..');
const projectConfig = join(packageRoot, 'tsconfig.json');
const compilerApi = new API({ cwd: packageRoot });
const compilerSnapshot = compilerApi.updateSnapshot({ openProjects: [projectConfig] });
const compilerProject = loadCompilerProject();

after(() => {
  compilerSnapshot.dispose();
  compilerApi.close();
});

function loadCompilerProject() {
  const project = compilerSnapshot.getProject(projectConfig);
  if (!project) throw new Error('TypeScript did not load the CLI project');
  return project;
}

test('the Runtime Host run entry cannot reach the embedded Runtime or writer Stores', () => {
  const reached = reachableModules(join(sourceRoot, 'runtime-host-run-command.ts'));
  const forbiddenModules = new Set([
    'embedded-tui-command.ts',
    'run-command.ts',
    'runtime-bootstrap.ts',
  ]);
  const violations: string[] = [];
  for (const path of reached) {
    const localPath = relative(sourceRoot, path);
    if (forbiddenModules.has(localPath)) violations.push(localPath);
    for (const specifier of runtimeModuleSpecifiers(path)) {
      if (specifier === '@maka/storage' || specifier.startsWith('@maka/storage/')) {
        violations.push(`${localPath}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

function reachableModules(entrypoint: string): Set<string> {
  const reached = new Set<string>();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || reached.has(path)) continue;
    reached.add(path);
    for (const specifier of runtimeModuleSpecifiers(path)) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(path), specifier).replace(/\.js$/, '.ts');
      if (target.startsWith(`${sourceRoot}/`)) pending.push(target);
    }
  }
  return reached;
}

function runtimeModuleSpecifiers(path: string): string[] {
  const source = compilerProject.program.getSourceFile(path);
  if (!source) throw new Error(`TypeScript did not load ${path}`);
  const specifiers: string[] = [];
  source.forEachChild((node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

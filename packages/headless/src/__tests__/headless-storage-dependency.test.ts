import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const sourceRoot = join(process.cwd(), 'src');
const packageRoot = resolve(sourceRoot, '..');
const distRoot = join(packageRoot, 'dist');
const harborRoot = join(packageRoot, 'harbor');
const storageCompositionModule = join(sourceRoot, 'headless-storage.ts');
const taskRunStoreModule = join(sourceRoot, 'task-run-store.ts');
const productionJavaScriptModules = listProductionJavaScriptModules(harborRoot);
const rawStorageWriterFactories = [
  'createAgentRunStore',
  'createArtifactStore',
  'createRuntimeEventStore',
  'createSessionStore',
  'openHeadlessArtifactStoreForWrite',
] as const;
const compilerApi = new API({ cwd: process.cwd() });
const projectConfig = join(process.cwd(), 'tsconfig.json');
const compilerSnapshot = compilerApi.updateSnapshot({
  openProjects: [projectConfig],
  openFiles: productionJavaScriptModules,
});
const compilerProject = loadCompilerProject();

after(() => {
  compilerSnapshot.dispose();
  compilerApi.close();
});

function loadCompilerProject() {
  const project = compilerSnapshot.getProject(projectConfig);
  if (!project) throw new Error(`TypeScript did not load ${projectConfig}`);
  return project;
}

test('only the Headless storage composition imports production writer factories', async () => {
  const violations: string[] = [];
  const productionModules = [
    ...(await listProductionTypeScriptFiles(sourceRoot)),
    ...productionJavaScriptModules,
  ];
  for (const path of productionModules) {
    if (path === storageCompositionModule) continue;
    for (const reference of moduleReferences(path)) {
      for (const symbol of forbiddenWriterSymbols(path, reference)) {
        violations.push(`${relative(sourceRoot, path)}: ${reference.specifier} -> ${symbol}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the boundary recognizes every writer imported by the storage composition', () => {
  const symbols = moduleReferences(storageCompositionModule)
    .flatMap((reference) => forbiddenWriterSymbols(storageCompositionModule, reference))
    .sort();
  assert.deepEqual(symbols, [
    'openHeadlessArtifactStoreForWrite',
    'openHeadlessExecutionStoresForWrite',
    'openHeadlessTaskRunWriter',
  ]);
});

interface ModuleReference {
  specifier: string;
  importedNames: string[] | null;
}

function forbiddenWriterSymbols(importer: string, reference: ModuleReference): string[] {
  if (reference.specifier === '@maka/storage') {
    if (reference.importedNames === null) return [...rawStorageWriterFactories];
    return reference.importedNames.filter((name) =>
      rawStorageWriterFactories.includes(name as (typeof rawStorageWriterFactories)[number]),
    );
  }
  if (reference.specifier === '@maka/storage/artifact-stores') {
    if (reference.importedNames === null) return ['openHeadlessArtifactStoreForWrite'];
    return reference.importedNames.filter((name) => name === 'openHeadlessArtifactStoreForWrite');
  }
  if (reference.specifier === '@maka/storage/execution-stores') {
    if (reference.importedNames === null) return ['writer opener'];
    return reference.importedNames.filter((name) => /^open[A-Za-z0-9]*ForWrite$/.test(name));
  }
  if (
    reference.specifier.startsWith('.') &&
    sourcePathForSpecifier(importer, reference.specifier) === taskRunStoreModule &&
    (reference.importedNames === null ||
      reference.importedNames.includes('openHeadlessTaskRunWriter'))
  ) {
    return ['openHeadlessTaskRunWriter'];
  }
  return [];
}

async function listProductionTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === '__tests__') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listProductionTypeScriptFiles(path)));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function listProductionJavaScriptModules(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listProductionJavaScriptModules(path));
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) files.push(path);
  }
  return files.sort();
}

function moduleReferences(path: string): ModuleReference[] {
  const source =
    compilerProject.program.getSourceFile(path) ??
    compilerSnapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
  if (!source) throw new Error(`TypeScript did not load ${path}`);
  const references: ModuleReference[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        importedNames: importDeclarationNames(node),
      });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      references.push({
        specifier: node.moduleSpecifier.text,
        importedNames: exportDeclarationNames(node),
      });
    }
    node.forEachChild(visit);
  };
  visit(source);
  return references;
}

function importDeclarationNames(node: ts.ImportDeclaration): string[] | null {
  const clause = node.importClause;
  if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return [];
  const names: string[] = [];
  if (clause.name) names.push('default');
  if (!clause.namedBindings) return names;
  if (ts.isNamespaceImport(clause.namedBindings)) return null;
  for (const element of clause.namedBindings.elements) {
    if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
  }
  return names;
}

function exportDeclarationNames(node: ts.ExportDeclaration): string[] | null {
  if (node.isTypeOnly) return [];
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return null;
  return node.exportClause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text);
}

function sourcePathForSpecifier(importer: string, specifier: string): string {
  const resolvedTarget = resolve(dirname(importer), specifier);
  const target = resolvedTarget.startsWith(`${distRoot}${sep}`)
    ? join(sourceRoot, relative(distRoot, resolvedTarget))
    : resolvedTarget;
  if (target.endsWith('.js')) return `${target.slice(0, -3)}.ts`;
  return target.endsWith('.ts') ? target : `${target}.ts`;
}

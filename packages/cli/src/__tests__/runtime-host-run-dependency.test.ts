import assert from 'node:assert/strict';
import {
  dirname,
  isAbsolute as isAbsolutePath,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SessionManager as EmbeddedSessionManagerFixture } from '@maka/runtime';
import type { SessionManager as EmbeddedSubpathSessionManagerFixture } from '@maka/runtime/session-manager';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

export { SessionManager as EmbeddedSessionManagerReexportFixture } from '@maka/runtime';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const packageRoot = resolve(sourceRoot, '..');
const projectConfig = join(packageRoot, 'tsconfig.json');
const compilerApi = new API({ cwd: packageRoot });
const compilerSnapshot = compilerApi.updateSnapshot({ openProjects: [projectConfig] });
const compilerProject = loadCompilerProject();
let dependencyScannerRuntimeOwnerFixture: EmbeddedSessionManagerFixture | undefined;
void dependencyScannerRuntimeOwnerFixture;
let dependencyScannerRuntimeSubpathFixture: EmbeddedSubpathSessionManagerFixture | undefined;
void dependencyScannerRuntimeSubpathFixture;
type EmbeddedSessionManagerImportTypeFixture = import('@maka/runtime').SessionManager;
let dependencyScannerRuntimeImportTypeFixture: EmbeddedSessionManagerImportTypeFixture | undefined;
void dependencyScannerRuntimeImportTypeFixture;

async function dependencyScannerFixture(target: string): Promise<void> {
  await import('../run-command.js');
  await import('@maka/storage');
  await import('@maka/runtime');
  await import('@maka/runtime-host/server');
  await import(target);
}
void dependencyScannerFixture;

function dependencyScannerLoaderFixture(): void {
  const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);
  load('@maka/storage');
}
void dependencyScannerLoaderFixture;

function dependencyScannerBracketLoaderFixture(): void {
  const load = process['getBuiltinModule']('node:module').createRequire(import.meta.url);
  load('@maka/storage');
}
void dependencyScannerBracketLoaderFixture;

const { getBuiltinModule: dependencyScannerGetBuiltinModule } = process;
function dependencyScannerAliasedLoaderFixture(): void {
  const load = dependencyScannerGetBuiltinModule('node:module').createRequire(import.meta.url);
  load('@maka/storage');
}
void dependencyScannerAliasedLoaderFixture;

const dependencyScannerProcessAlias = process;
function dependencyScannerProcessAliasFixture(): void {
  const load = dependencyScannerProcessAlias
    .getBuiltinModule('node:module')
    .createRequire(import.meta.url);
  load('@maka/storage');
}
void dependencyScannerProcessAliasFixture;

function dependencyScannerGlobalProcessFixture(): void {
  const load = globalThis.process.getBuiltinModule('node:module').createRequire(import.meta.url);
  load('@maka/storage');
}
void dependencyScannerGlobalProcessFixture;

after(() => {
  compilerSnapshot.dispose();
  compilerApi.close();
});

function loadCompilerProject() {
  const project = compilerSnapshot.getProject(projectConfig);
  if (!project) throw new Error('TypeScript did not load the CLI project');
  return project;
}

test('Runtime Host CLI entries cannot reach embedded Runtime owners or writer Stores', () => {
  const forbiddenModules = new Set([
    'embedded-tui-command.ts',
    'run-command.ts',
    'runtime-bootstrap.ts',
  ]);
  const violations: string[] = [];
  for (const entrypoint of [
    'runtime-host-run-command.ts',
    'runtime-host-tui-command.ts',
    'live-inspect-backend.ts',
  ]) {
    for (const path of reachableModules(join(sourceRoot, entrypoint))) {
      const localPath = relative(sourceRoot, path);
      const references = moduleReferences(path);
      if (forbiddenModules.has(localPath)) violations.push(`${entrypoint}: ${localPath}`);
      for (const violation of workspaceBoundaryViolations(references)) {
        violations.push(`${entrypoint}: ${localPath}: ${violation}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the dependency gate rejects hidden loads and every workspace owner reference shape', () => {
  const path = join(sourceRoot, '__tests__', 'runtime-host-run-dependency.test.ts');
  const scan = scanModuleReferences(path);
  assert.ok(scan.references.some((reference) => reference.specifier === '../run-command.js'));
  assert.ok(scan.references.some((reference) => reference.specifier === '@maka/storage'));
  assert.equal(scan.nonStaticLoads.length, 1);
  assert.match(scan.nonStaticLoads[0] ?? '', /import\(\.\.\.\)/);
  assert.ok(
    scan.forbiddenLoaderCapabilities.some((violation) =>
      violation.endsWith('getBuiltinModule: process.getBuiltinModule'),
    ),
  );
  assert.ok(
    scan.forbiddenLoaderCapabilities.some((violation) =>
      violation.endsWith("getBuiltinModule: process['getBuiltinModule']"),
    ),
  );
  assert.ok(
    scan.forbiddenLoaderCapabilities.some((violation) =>
      violation.endsWith('getBuiltinModule: getBuiltinModule'),
    ),
  );
  assert.ok(
    scan.forbiddenLoaderCapabilities.some((violation) =>
      violation.endsWith('getBuiltinModule: dependencyScannerProcessAlias.getBuiltinModule'),
    ),
  );
  assert.ok(
    scan.forbiddenLoaderCapabilities.some((violation) =>
      violation.endsWith('getBuiltinModule: globalThis.process.getBuiltinModule'),
    ),
  );
  const runtimeViolations = workspaceBoundaryViolations(scan.references);
  assert.ok(runtimeViolations.some((violation) => /import .*SessionManager/.test(violation)));
  assert.ok(runtimeViolations.some((violation) => /export .*SessionManager/.test(violation)));
  assert.ok(runtimeViolations.some((violation) => /import_type .*SessionManager/.test(violation)));
  assert.ok(
    runtimeViolations.some((violation) =>
      /@maka\/runtime\/session-manager is not an allowed client module/.test(violation),
    ),
  );
  assert.ok(runtimeViolations.some((violation) => /dynamic .*unbounded/.test(violation)));
  assert.ok(
    runtimeViolations.some((violation) =>
      /@maka\/runtime-host\/server is not an allowed client module/.test(violation),
    ),
  );
  assert.deepEqual(
    workspaceBoundaryViolations([
      {
        specifier: 'maka-agent',
        kind: 'import',
        bindings: ['createMakaCliRuntimeContext'],
      },
      {
        specifier: '@maka/runtime-host/execution-candidate-main',
        kind: 'import',
        bindings: ['startRuntimeHostCandidate'],
      },
    ]),
    [
      'import maka-agent is not an allowed client module',
      'import @maka/runtime-host/execution-candidate-main is not an allowed client module',
    ],
  );
  assert.deepEqual(
    workspaceBoundaryViolations([
      { specifier: 'file:///tmp/runtime-owner.js', kind: 'dynamic', bindings: null },
      { specifier: 'data:text/javascript,export default 1', kind: 'dynamic', bindings: null },
      { specifier: 'C:\\runtime-owner.js', kind: 'import', bindings: ['owner'] },
      { specifier: '#runtime-owner', kind: 'import', bindings: ['owner'] },
    ]),
    [
      'dynamic file:///tmp/runtime-owner.js is not a portable static module specifier',
      'dynamic data:text/javascript,export default 1 is not a portable static module specifier',
      'import C:\\runtime-owner.js is not a portable static module specifier',
      'import #runtime-owner is not a portable static module specifier',
    ],
  );
});

function reachableModules(entrypoint: string): Set<string> {
  const reached = new Set<string>();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || reached.has(path)) continue;
    reached.add(path);
    for (const { specifier } of moduleReferences(path)) {
      if (!specifier.startsWith('.')) continue;
      const target = sourcePathForLocalSpecifier(path, specifier);
      if (!isInside(sourceRoot, target)) {
        throw new Error(
          `Runtime Host CLI dependency escapes its source root: ${path}: ${specifier}`,
        );
      }
      pending.push(target);
    }
  }
  return reached;
}

function moduleReferences(path: string): readonly ModuleReference[] {
  const scan = scanModuleReferences(path);
  const violations = [...scan.nonStaticLoads, ...scan.forbiddenLoaderCapabilities];
  if (violations.length > 0) {
    throw new Error(
      `Dependency boundary requires explicit module declarations:\n${violations.join('\n')}`,
    );
  }
  return scan.references;
}

type ModuleReferenceKind = 'import' | 'export' | 'import_type' | 'dynamic' | 'require';

interface ModuleReference {
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  readonly bindings: readonly string[] | null;
}

function scanModuleReferences(path: string): {
  references: ModuleReference[];
  nonStaticLoads: string[];
  forbiddenLoaderCapabilities: string[];
} {
  const source = compilerProject.program.getSourceFile(path);
  if (!source) throw new Error(`TypeScript did not load ${path}`);
  const references: ModuleReference[] = [];
  const nonStaticLoads: string[] = [];
  const forbiddenLoaderCapabilities: string[] = [];
  const visit = (node: ts.Node): void => {
    const loaderCapability = loaderCapabilityName(node);
    if (loaderCapability) {
      const violation = `${path}: ${loaderCapability}: ${node.getText(source).replace(/\s+/g, '')}`;
      if (!forbiddenLoaderCapabilities.includes(violation)) {
        forbiddenLoaderCapabilities.push(violation);
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        kind: 'import',
        bindings: importBindings(node),
      });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      references.push({
        specifier: node.moduleSpecifier.text,
        kind: 'export',
        bindings: exportBindings(node),
      });
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const target = node.arguments[0];
      if (target && ts.isStringLiteralLikeNode(target)) {
        references.push({
          specifier: target.text,
          kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic' : 'require',
          bindings: null,
        });
      } else {
        nonStaticLoads.push(
          `${path}: ${node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require'}(...)`,
        );
      }
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      references.push({
        specifier: node.argument.literal.text,
        kind: 'import_type',
        bindings: node.qualifier ? [leftmostEntityName(node.qualifier)] : null,
      });
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLikeNode(node.moduleReference.expression)
    ) {
      references.push({
        specifier: node.moduleReference.expression.text,
        kind: 'require',
        bindings: null,
      });
    }
    node.forEachChild(visit);
  };
  visit(source);
  for (const reference of references) {
    if (reference.specifier === 'node:module' || reference.specifier === 'module') {
      forbiddenLoaderCapabilities.push(`${path}: ${reference.specifier}`);
    }
  }
  return { references, nonStaticLoads, forbiddenLoaderCapabilities };
}

type WorkspaceImportPolicy = 'named' | ReadonlySet<string>;

const workspacePresentationImports = new Map<string, WorkspaceImportPolicy>([
  [
    '@maka/runtime',
    new Set([
      'AgentRunInspectDocument',
      'ChatItem',
      'ContextDiagnostics',
      'GoalObservedTurnSettler',
      'GoalObservedTurnStart',
      'GoalTurnAdmission',
      'GoalTurnOutcome',
      'HostCapabilities',
      'InvocationResult',
      'InvocableSkillEntry',
      'RuntimeContinuation',
      'SafeBoundaryContinuationPlan',
      'SESSION_RECAP_INSTRUCTION',
      'SessionActivityLease',
      'SessionActivityRegistry',
      'SessionInspectDocument',
      'SkillSource',
      'ToolActivityItem',
      'cleanSessionRecapText',
      'drainGoalTurn',
      'listInvocableSkills',
      'materializeSession',
      'prepareSkillInvocationMessage',
    ]),
  ],
  ['@maka/headless', new Set(['TaskRunInspectDocument'])],
  ['@maka/runtime-host/adapter', 'named'],
  ['@maka/runtime-host/client', 'named'],
  ['@maka/runtime-host/protocol', 'named'],
]);

function workspaceBoundaryViolations(references: readonly ModuleReference[]): string[] {
  const violations: string[] = [];
  for (const reference of references) {
    if (!isPortableStaticSpecifier(reference.specifier)) {
      violations.push(
        `${reference.kind} ${reference.specifier} is not a portable static module specifier`,
      );
      continue;
    }
    if (!isWorkspaceSpecifier(reference.specifier)) continue;
    const allowed = workspaceImportPolicy(reference.specifier);
    if (allowed === undefined) {
      violations.push(`${reference.kind} ${reference.specifier} is not an allowed client module`);
      continue;
    }
    if (!reference.bindings) {
      violations.push(`${reference.kind} ${reference.specifier} is unbounded`);
      continue;
    }
    for (const binding of reference.bindings) {
      if (
        binding === 'default' ||
        binding === '*' ||
        (allowed !== 'named' && !allowed.has(binding))
      ) {
        violations.push(`${reference.kind} ${reference.specifier} ${binding}`);
      }
    }
  }
  return violations;
}

function isPortableStaticSpecifier(specifier: string): boolean {
  if (posix.isAbsolute(specifier) || win32.isAbsolute(specifier) || specifier.startsWith('#')) {
    return false;
  }
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(specifier)?.[0];
  return scheme === undefined || scheme === 'node:';
}

function isWorkspaceSpecifier(specifier: string): boolean {
  return (
    specifier === 'maka-agent' ||
    specifier.startsWith('maka-agent/') ||
    specifier.startsWith('@maka/')
  );
}

function workspaceImportPolicy(specifier: string): WorkspaceImportPolicy | undefined {
  if (specifier === '@maka/core' || specifier.startsWith('@maka/core/')) return 'named';
  return workspacePresentationImports.get(specifier);
}

function importBindings(node: ts.ImportDeclaration): readonly string[] | null {
  const clause = node.importClause;
  if (!clause) return null;
  const bindings: string[] = [];
  if (clause.name) bindings.push('default');
  if (!clause.namedBindings) return bindings.length > 0 ? bindings : null;
  if (ts.isNamespaceImport(clause.namedBindings)) return [...bindings, '*'];
  return [
    ...bindings,
    ...clause.namedBindings.elements.map((element) =>
      element.propertyName ? element.propertyName.text : element.name.text,
    ),
  ];
}

function exportBindings(node: ts.ExportDeclaration): readonly string[] | null {
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return null;
  return node.exportClause.elements.map((element) =>
    element.propertyName ? element.propertyName.text : element.name.text,
  );
}

function leftmostEntityName(name: ts.EntityName): string {
  let current = name;
  while (ts.isQualifiedName(current)) current = current.left;
  return current.text;
}

function loaderCapabilityName(node: ts.Node): string | undefined {
  if (
    ts.isElementAccessExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === 'process') ||
      (node.argumentExpression &&
        ts.isStringLiteralLikeNode(node.argumentExpression) &&
        node.argumentExpression.text === 'getBuiltinModule'))
  ) {
    return 'getBuiltinModule';
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'getBuiltinModule') {
    return 'getBuiltinModule';
  }
  if (ts.isIdentifier(node) && node.text === 'getBuiltinModule') {
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return undefined;
    return 'getBuiltinModule';
  }
  if (!ts.isIdentifier(node) || node.text !== 'require') return undefined;
  if (
    (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
    (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
    (node.parent as { name?: ts.Node }).name === node
  ) {
    return undefined;
  }
  return 'require';
}

function sourcePathForLocalSpecifier(importer: string, specifier: string): string {
  const target = resolve(dirname(importer), specifier);
  if (target.endsWith('.js')) return `${target.slice(0, -3)}.ts`;
  return target.endsWith('.ts') ? target : `${target}.ts`;
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolutePath(child);
}

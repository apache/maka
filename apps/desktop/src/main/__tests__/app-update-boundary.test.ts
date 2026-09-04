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

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
// The architecture checker is an executable JavaScript module by design.
// @ts-expect-error It does not publish a declaration file.
import { analyzeRendererSource } from '../../../scripts/check-renderer-architecture.mjs';

const desktopRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const rendererRoot = join(desktopRoot, 'src', 'renderer');
const featureRoot = join(rendererRoot, 'features', 'app-update');
const uiPackageRoot = resolve(desktopRoot, '..', '..', 'packages', 'ui');
const uiRoot = join(uiPackageRoot, 'src');
const sourceCache = new Map<string, string>();
const analysisCache = new Map<string, ReturnType<typeof analyzeRendererSource>>();

function sourceOf(path: string): string {
  const cached = sourceCache.get(path);
  if (cached !== undefined) return cached;
  const source = readFileSync(path, 'utf8');
  sourceCache.set(path, source);
  return source;
}

function analysisOf(path: string): ReturnType<typeof analyzeRendererSource> {
  const cached = analysisCache.get(path);
  if (cached) return cached;
  const analysis = analyzeRendererSource(sourceOf(path), path);
  analysisCache.set(path, analysis);
  return analysis;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|md)$/.test(entry.name) ? [path] : [];
  });
}

function productionRendererSources(): string[] {
  return sourceFiles(rendererRoot).filter((path) =>
    /\.tsx?$/.test(path) &&
    !path.replace(/\\/g, '/').includes('/__tests__/') &&
    !path.endsWith(`${join('', 'testing.ts')}`),
  );
}

function productionUiSources(): string[] {
  return sourceFiles(uiRoot).filter((path) =>
    /\.tsx?$/.test(path) &&
    !path.replace(/\\/g, '/').includes('/__tests__/'),
  );
}

function productSourceLabel(path: string): string {
  if (path.startsWith(desktopRoot)) {
    return `apps/desktop/${relative(desktopRoot, path).replace(/\\/g, '/')}`;
  }
  return `packages/ui/${relative(uiPackageRoot, path).replace(/\\/g, '/')}`;
}

function jsxBindings(source: string, file: string, exportedName: string) {
  const ast = parse(source, {
    createImportExpressions: true,
    sourceType: 'module',
    sourceFilename: file,
    plugins: ['typescript', 'jsx'],
  });
  const imports = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const openings: string[] = [];
  const namespaceOpenings: Array<{ namespace: string; name: string }> = [];

  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'ImportDeclaration') {
      const sourceNode = node.source as { value?: unknown } | undefined;
      for (const specifier of (node.specifiers as Array<Record<string, unknown>> | undefined) ?? []) {
        const local = specifier.local as { name?: unknown } | undefined;
        if (specifier.type === 'ImportNamespaceSpecifier' && typeof local?.name === 'string') {
          namespaces.set(local.name, String(sourceNode?.value ?? ''));
          continue;
        }
        if (specifier.type !== 'ImportSpecifier') continue;
        const imported = specifier.imported as { name?: unknown; value?: unknown } | undefined;
        if (
          (imported?.name === exportedName || imported?.value === exportedName) &&
          typeof local?.name === 'string'
        ) {
          imports.set(local.name, String(sourceNode?.value ?? ''));
        }
      }
    }
    if (node.type === 'JSXOpeningElement') {
      const name = node.name as Record<string, unknown> | undefined;
      if (name?.type === 'JSXIdentifier' && typeof name.name === 'string') {
        openings.push(name.name);
      }
      if (name?.type === 'JSXMemberExpression') {
        const object = name.object as { type?: unknown; name?: unknown } | undefined;
        const property = name.property as { type?: unknown; name?: unknown } | undefined;
        if (
          object?.type === 'JSXIdentifier' && typeof object.name === 'string' &&
          property?.type === 'JSXIdentifier' && typeof property.name === 'string'
        ) {
          namespaceOpenings.push({ namespace: object.name, name: property.name });
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'start' && key !== 'end') visit(child);
    }
  }

  visit(ast.program);
  return [
    ...[...imports.entries()].flatMap(([local, dependency]) =>
      openings.filter((name) => name === local).map(() => dependency),
    ),
    ...namespaceOpenings.flatMap((opening) => {
      const dependency = namespaces.get(opening.namespace);
      return opening.name === exportedName && dependency ? [dependency] : [];
    }),
  ];
}

function moduleEntryBindings(
  source: string,
  file: string,
  matches: (dependency: string) => boolean,
): string[] {
  const ast = parse(source, {
    createImportExpressions: true,
    sourceType: 'module',
    sourceFilename: file,
    plugins: ['typescript', 'jsx'],
  });
  const bindings: string[] = [];

  function importedName(value: { type: string; name?: string; value?: string }): string {
    return value.type === 'Identifier' ? String(value.name) : String(value.value);
  }

  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'ImportDeclaration') {
      const dependency = String((node.source as { value?: unknown } | undefined)?.value ?? '');
      if (matches(dependency)) {
        for (const specifier of (node.specifiers as Array<Record<string, unknown>> | undefined) ?? []) {
          if (specifier.type === 'ImportSpecifier') {
            bindings.push(importedName(specifier.imported as Parameters<typeof importedName>[0]));
          } else if (specifier.type === 'ImportDefaultSpecifier') {
            bindings.push('default');
          } else {
            bindings.push('*');
          }
        }
      }
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const dependency = String((node.source as { value?: unknown } | undefined)?.value ?? '');
      if (matches(dependency)) {
        if (node.type === 'ExportAllDeclaration') {
          bindings.push('export:*');
        } else {
          for (const specifier of (node.specifiers as Array<Record<string, unknown>> | undefined) ?? []) {
            if (specifier.type === 'ExportSpecifier') {
              bindings.push(
                `export:${importedName(specifier.local as Parameters<typeof importedName>[0])}`,
              );
            } else {
              bindings.push('export:*');
            }
          }
        }
      }
    }
    if (node.type === 'ImportExpression') {
      const dependency = String((node.source as { value?: unknown } | undefined)?.value ?? '');
      if (matches(dependency)) bindings.push('dynamic:*');
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'start' && key !== 'end') visit(child);
    }
  }

  visit(ast.program);
  return bindings;
}

function featureEntryImports(source: string, file: string): string[] {
  return moduleEntryBindings(
    source,
    file,
    (dependency) => dependency.includes('features/app-update'),
  );
}

function desktopAppUpdateAdapterBindings(source: string, file: string): string[] {
  return moduleEntryBindings(
    source,
    file,
    (dependency) => dependency.includes('platform/desktop/create-app-update-services'),
  );
}

function sidebarProjectionEntryBindings(source: string, file: string): string[] {
  return moduleEntryBindings(
    source,
    file,
    (dependency) =>
      dependency === '@maka/ui' ||
      dependency.startsWith('@maka/ui/') ||
      dependency.includes('sidebar-update-projection-context'),
  ).filter((binding) => {
    const name = binding.replace(/^(?:export:|dynamic:)/, '');
    return name === '*' ||
      name === 'SidebarUpdateProjectionProvider' ||
      name === 'useSidebarUpdateProjection';
  });
}

describe('App Update feature boundary', () => {
  test('recognizes alias, namespace, re-export, and dynamic-import escape hatches', () => {
    const dependency = './features/app-update/index.js';
    assert.deepEqual(
      moduleEntryBindings(
        [
          `import { AppUpdateProvider as Provider } from '${dependency}';`,
          `import * as AppUpdate from '${dependency}';`,
          `export { AppUpdateProvider as UpdateOwner } from '${dependency}';`,
          `export * from '${dependency}';`,
          `void import('${dependency}');`,
        ].join('\n'),
        'fixture.tsx',
        (candidate) => candidate.includes('features/app-update'),
      ),
      ['AppUpdateProvider', '*', 'export:AppUpdateProvider', 'export:*', 'dynamic:*'],
    );
    assert.deepEqual(
      jsxBindings(
        [
          `import { AppUpdateProvider as Provider } from '${dependency}';`,
          `import * as AppUpdate from '${dependency}';`,
          '<><Provider /><AppUpdate.AppUpdateProvider /></>',
        ].join('\n'),
        'fixture.tsx',
        'AppUpdateProvider',
      ),
      [dependency, dependency],
    );
  });

  test('keeps the controller hook exclusively owned by AppUpdateProvider', () => {
    const owners: string[] = [];
    for (const path of productionRendererSources()) {
      const analysis = analysisOf(path);
      const calls = analysis.hookCalls.useAppUpdateController ?? 0;
      for (let index = 0; index < calls; index += 1) {
        owners.push(relative(desktopRoot, path).replace(/\\/g, '/'));
      }
    }
    assert.deepEqual(owners, [
      'src/renderer/features/app-update/ui/app-update-provider.tsx',
    ]);
  });

  test('keeps the services hook exclusively owned by the controller', () => {
    const owners: string[] = [];
    for (const path of productionRendererSources()) {
      const analysis = analysisOf(path);
      const calls = analysis.hookCalls.useAppUpdateServices ?? 0;
      for (let index = 0; index < calls; index += 1) {
        owners.push(relative(desktopRoot, path).replace(/\\/g, '/'));
      }
    }
    assert.deepEqual(owners, [
      'src/renderer/features/app-update/controller/use-app-update-controller.ts',
    ]);
  });

  test('keeps Desktop globals and shell/process dependencies out of the feature', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(featureRoot)) {
      if (!/\.tsx?$/.test(path) || path.endsWith('testing.ts')) continue;
      const analysis = analysisOf(path);
      for (const capability of Object.keys(analysis.bridgePaths)) {
        violations.push(`${relative(desktopRoot, path)}: ${capability}`);
      }
      for (const dependency of analysis.dependencies as string[]) {
        if (
          dependency.includes('app-shell') ||
          dependency.includes('/preload/') ||
          dependency.includes('/main/') ||
          dependency.includes('/settings/')
        ) {
          violations.push(`${relative(desktopRoot, path)}: ${dependency}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test('allows consumers to enter only through production or testing entries', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(join(desktopRoot, 'src'))) {
      if (path.startsWith(featureRoot) || !/\.tsx?$/.test(path)) continue;
      const analysis = analysisOf(path);
      for (const dependency of analysis.dependencies as string[]) {
        if (!dependency.includes('features/app-update')) continue;
        const normalized = dependency.replace(/\\/g, '/');
        const explicitEntry = normalized.endsWith('/features/app-update')
          ? `${normalized}/index`
          : normalized;
        const productionRenderer = path.startsWith(rendererRoot) &&
          !path.replace(/\\/g, '/').includes('/__tests__/');
        const allowed = productionRenderer
          ? /\/features\/app-update\/index(?:\.js)?$/
          : /\/features\/app-update\/(?:index|testing)(?:\.js)?$/;
        if (!allowed.test(explicitEntry)) {
          violations.push(`${relative(desktopRoot, path)}: ${dependency}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test('pins the production entry surface to its composition and leaf owners', () => {
    const imports: string[] = [];
    for (const path of productionRendererSources()) {
      const source = sourceOf(path);
      const owner = relative(desktopRoot, path).replace(/\\/g, '/');
      for (const imported of featureEntryImports(source, path)) {
        imports.push(`${owner}: ${imported}`);
      }
    }
    assert.deepEqual(imports.sort(), [
      'src/renderer/app-shell.tsx: AppUpdateProvider',
      'src/renderer/composition/desktop-feature-services.tsx: AppUpdateServicesProvider',
      'src/renderer/platform/desktop/create-app-update-services.ts: AppUpdateServices',
      'src/renderer/settings/about-settings-page.tsx: AppUpdateAboutProjection',
      'src/renderer/settings/about-settings-page.tsx: AppUpdateAboutProjectionConsumer',
      'src/renderer/settings/about-settings-page.tsx: aboutUpdateStatusDetail',
    ]);
  });

  test('keeps the Desktop adapter exclusively owned by feature-services composition', () => {
    const bindings: string[] = [];
    for (const path of productionRendererSources()) {
      const source = sourceOf(path);
      const owner = relative(desktopRoot, path).replace(/\\/g, '/');
      for (const binding of desktopAppUpdateAdapterBindings(source, path)) {
        bindings.push(`${owner}: ${binding}`);
      }
    }
    assert.deepEqual(bindings, [
      'src/renderer/composition/desktop-feature-services.tsx: createDesktopAppUpdateServices',
    ]);
  });

  test('pins sidebar projection runtime bindings to its provider and footer owners', () => {
    const bindings: string[] = [];
    for (const path of [...productionRendererSources(), ...productionUiSources()]) {
      const source = sourceOf(path);
      for (const binding of sidebarProjectionEntryBindings(source, path)) {
        bindings.push(`${productSourceLabel(path)}: ${binding}`);
      }
    }
    assert.deepEqual(bindings.sort(), [
      'apps/desktop/src/renderer/features/app-update/ui/app-update-provider.tsx: SidebarUpdateProjectionProvider',
      'packages/ui/src/components.tsx: export:SidebarUpdateProjectionProvider',
      'packages/ui/src/components.tsx: export:useSidebarUpdateProjection',
      'packages/ui/src/session-sidebar-nav.tsx: useSidebarUpdateProjection',
    ]);
  });

  test('keeps controller and fakes out of the production entry', () => {
    const productionEntry = sourceOf(join(featureRoot, 'index.ts'));
    assert.equal(productionEntry.includes('useAppUpdateController'), false);
    assert.equal(productionEntry.includes('createFakeAppUpdateServices'), false);
    assert.equal(productionEntry.includes("from './testing"), false);
  });

  test('keeps raw update capabilities out of every production renderer module', () => {
    const updateCapabilities = [
      'window.maka.app.updateStatus',
      'window.maka.app.subscribeUpdateStatus',
      'window.maka.app.checkForUpdates',
      'window.maka.app.retryUpdateDownload',
      'window.maka.app.installUpdate',
      // A computed read from the app namespace could select any update method
      // and must not become a back door around the explicit capability list.
      'window.maka.app.*',
    ];
    const violations: string[] = [];
    for (const path of productionRendererSources()) {
      const relativePath = relative(desktopRoot, path).replace(/\\/g, '/');
      const analysis = analysisOf(path);
      for (const capability of updateCapabilities) {
        if ((analysis.bridgePaths[capability] ?? 0) > 0) {
          violations.push(`${relativePath}: ${capability}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test('mounts one public Provider and binds each projection at its narrow leaf', () => {
    const providerOwners: string[] = [];
    const aboutReaders: string[] = [];
    const sidebarProviderOwners: string[] = [];
    for (const path of productionRendererSources()) {
      const source = sourceOf(path);
      for (const dependency of jsxBindings(source, path, 'AppUpdateProvider')) {
        if (dependency.includes('features/app-update')) {
          providerOwners.push(relative(desktopRoot, path).replace(/\\/g, '/'));
        }
      }
      for (const dependency of jsxBindings(source, path, 'AppUpdateAboutProjectionConsumer')) {
        if (dependency.includes('features/app-update')) {
          aboutReaders.push(relative(desktopRoot, path).replace(/\\/g, '/'));
        }
      }
      for (const dependency of jsxBindings(source, path, 'SidebarUpdateProjectionProvider')) {
        if (dependency === '@maka/ui') {
          sidebarProviderOwners.push(productSourceLabel(path));
        }
      }
    }
    for (const path of productionUiSources()) {
      const source = sourceOf(path);
      for (const dependency of jsxBindings(source, path, 'SidebarUpdateProjectionProvider')) {
        if (dependency.includes('sidebar-update-projection-context')) {
          sidebarProviderOwners.push(productSourceLabel(path));
        }
      }
    }
    assert.deepEqual(providerOwners, ['src/renderer/app-shell.tsx']);
    assert.deepEqual(aboutReaders, ['src/renderer/settings/about-settings-page.tsx']);
    assert.deepEqual(sidebarProviderOwners, [
      'apps/desktop/src/renderer/features/app-update/ui/app-update-provider.tsx',
    ]);

    const sidebarReaders: string[] = [];
    for (const path of [...productionRendererSources(), ...productionUiSources()]) {
      const analysis = analysisOf(path);
      if ((analysis.hookCalls.useSidebarUpdateProjection ?? 0) > 0) {
        sidebarReaders.push(productSourceLabel(path));
      }
    }
    assert.deepEqual(sidebarReaders, ['packages/ui/src/session-sidebar-nav.tsx']);
  });
});

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
const featureRoot = join(rendererRoot, 'features', 'overlays');
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
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function relativeSource(path: string): string {
  return relative(desktopRoot, path).replace(/\\/g, '/');
}

function productionRendererSources(): string[] {
  return sourceFiles(rendererRoot).filter(
    (path) =>
      !path.replace(/\\/g, '/').includes('/__tests__/') && !path.endsWith(join('', 'testing.ts')),
  );
}

function parseModule(source: string, file: string) {
  return parse(source, {
    createImportExpressions: true,
    sourceType: 'module',
    sourceFilename: file,
    plugins: ['typescript', 'jsx'],
  });
}

function visit(value: unknown, onNode: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) visit(child, onNode);
    return;
  }
  const node = value as Record<string, unknown>;
  onNode(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'loc' && key !== 'start' && key !== 'end') visit(child, onNode);
  }
}

/** Every JSX mount of `exportedName` bound from a module matching `matches`. */
function jsxMounts(
  source: string,
  file: string,
  exportedName: string,
  matches: (dependency: string) => boolean,
): number {
  const locals = new Set<string>();
  const namespaces = new Set<string>();
  let mounts = 0;
  visit(parseModule(source, file).program, (node) => {
    if (node.type === 'ImportDeclaration') {
      const dependency = String((node.source as { value?: unknown }).value ?? '');
      if (!matches(dependency)) return;
      for (const specifier of (node.specifiers as Array<Record<string, unknown>>) ?? []) {
        const local = (specifier.local as { name?: string }).name ?? '';
        if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(local);
        const imported = specifier.imported as { name?: string; value?: string } | undefined;
        if (
          specifier.type === 'ImportSpecifier' &&
          (imported?.name === exportedName || imported?.value === exportedName)
        ) {
          locals.add(local);
        }
      }
    }
    if (node.type === 'JSXOpeningElement') {
      const name = node.name as Record<string, unknown>;
      if (name.type === 'JSXIdentifier' && locals.has(String(name.name))) mounts += 1;
      if (name.type === 'JSXMemberExpression') {
        const object = name.object as { name?: string };
        const property = name.property as { name?: string };
        if (namespaces.has(String(object.name)) && property.name === exportedName) mounts += 1;
      }
    }
  });
  return mounts;
}

/** Every binding a module takes from modules matching `matches`. */
function moduleBindings(
  source: string,
  file: string,
  matches: (dependency: string) => boolean,
): string[] {
  const bindings: string[] = [];
  const importedName = (value: { type: string; name?: string; value?: string }) =>
    value.type === 'Identifier' ? String(value.name) : String(value.value);
  visit(parseModule(source, file).program, (node) => {
    const dependency = String((node.source as { value?: unknown } | undefined)?.value ?? '');
    if (node.type === 'ImportDeclaration' && matches(dependency)) {
      for (const specifier of (node.specifiers as Array<Record<string, unknown>>) ?? []) {
        if (specifier.type === 'ImportSpecifier') {
          bindings.push(importedName(specifier.imported as Parameters<typeof importedName>[0]));
        } else if (specifier.type === 'ImportDefaultSpecifier') {
          bindings.push('default');
        } else {
          bindings.push('*');
        }
      }
    }
    if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      matches(dependency)
    ) {
      bindings.push('export:*');
    }
    if (node.type === 'ImportExpression' && matches(dependency)) bindings.push('dynamic:*');
  });
  return bindings;
}

const isFeatureEntry = (dependency: string) => dependency.includes('features/overlays');
const isDesktopAdapter = (dependency: string) =>
  dependency.includes('platform/desktop/create-overlays-services');

describe('Overlays feature boundary', () => {
  test('keeps the services hook exclusively owned by the controller', () => {
    const owners: string[] = [];
    for (const path of productionRendererSources()) {
      const calls = analysisOf(path).hookCalls.useOverlaysServices ?? 0;
      for (let index = 0; index < calls; index += 1) owners.push(relativeSource(path));
    }
    assert.deepEqual(owners, [
      'src/renderer/features/overlays/controller/use-overlays-controller.ts',
    ]);
  });

  test('keeps Desktop globals and shell/process dependencies out of the feature', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(featureRoot)) {
      if (path.endsWith('testing.ts')) continue;
      const analysis = analysisOf(path);
      for (const capability of Object.keys(analysis.bridgePaths)) {
        violations.push(`${relativeSource(path)}: ${capability}`);
      }
      for (const dependency of analysis.dependencies as string[]) {
        if (
          dependency.includes('app-shell') ||
          dependency.includes('/preload/') ||
          dependency.includes('/main/') ||
          dependency.includes('/settings/') ||
          dependency.includes('browser-storage')
        ) {
          violations.push(`${relativeSource(path)}: ${dependency}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test('pins the production entry surface to the shell, the overlay layer, and composition', () => {
    const imports: string[] = [];
    for (const path of productionRendererSources()) {
      for (const binding of moduleBindings(sourceOf(path), path, isFeatureEntry)) {
        imports.push(`${relativeSource(path)}: ${binding}`);
      }
    }
    assert.deepEqual(imports.sort(), [
      'src/renderer/app-shell-command-actions.ts: Command',
      'src/renderer/app-shell-overlays.tsx: *',
      'src/renderer/app-shell-overlays.tsx: OverlaysShellProjection',
      'src/renderer/app-shell.tsx: *',
      'src/renderer/app-shell.tsx: OverlaysShellProjection',
      'src/renderer/command-palette-commands.ts: Command',
      'src/renderer/composition/desktop-feature-services.tsx: OverlaysServicesProvider',
      'src/renderer/platform/desktop/create-overlays-services.ts: OverlaysServices',
    ]);
  });

  test('keeps the Desktop adapter exclusively owned by feature-services composition', () => {
    const bindings: string[] = [];
    for (const path of productionRendererSources()) {
      for (const binding of moduleBindings(sourceOf(path), path, isDesktopAdapter)) {
        bindings.push(`${relativeSource(path)}: ${binding}`);
      }
    }
    assert.deepEqual(bindings, [
      'src/renderer/composition/desktop-feature-services.tsx: createDesktopOverlaysServices',
    ]);
  });

  test('keeps the controller, the models, and the fakes out of the production entry', () => {
    const productionEntry = sourceOf(join(featureRoot, 'index.ts'));
    for (const name of ['useOverlaysController', 'createFakeOverlaysServices', "from './testing"]) {
      assert.equal(productionEntry.includes(name), false, name);
    }
    assert.equal(productionEntry.includes("from './controller/"), false);
  });

  test('keeps the raw search capability out of every production renderer module', () => {
    const violations: string[] = [];
    for (const path of productionRendererSources()) {
      const analysis = analysisOf(path);
      for (const capability of ['window.maka.search.thread', 'window.maka.search.*']) {
        if ((analysis.bridgePaths[capability] ?? 0) > 0) {
          violations.push(`${relativeSource(path)}: ${capability}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test('mounts one OverlaysRoot in the shell and the overlay UI only in the overlay layer', () => {
    const mounts: string[] = [];
    for (const path of productionRendererSources()) {
      const source = sourceOf(path);
      for (const name of [
        'OverlaysRoot',
        'OverlaysConsumer',
        'KeyboardHelpModal',
        'CommandPalette',
        'SearchModalHost',
      ]) {
        const count = jsxMounts(source, path, name, isFeatureEntry);
        for (let index = 0; index < count; index += 1) {
          mounts.push(`${relativeSource(path)}: ${name}`);
        }
      }
    }
    assert.deepEqual(mounts.sort(), [
      'src/renderer/app-shell-overlays.tsx: CommandPalette',
      'src/renderer/app-shell-overlays.tsx: KeyboardHelpModal',
      'src/renderer/app-shell-overlays.tsx: OverlaysConsumer',
      'src/renderer/app-shell-overlays.tsx: SearchModalHost',
      'src/renderer/app-shell.tsx: OverlaysRoot',
    ]);
  });

  test('leaves the shell with no overlay hook of its own', () => {
    const shell = analysisOf(join(rendererRoot, 'app-shell.tsx'));
    for (const hook of [
      'useOverlaysController',
      'useOverlays',
      'useKeyboardHelp',
      'useCommandPalette',
      'useShellSearch',
      'useSettingsModal',
    ]) {
      assert.equal(shell.hookCalls[hook] ?? 0, 0, hook);
    }
  });
});

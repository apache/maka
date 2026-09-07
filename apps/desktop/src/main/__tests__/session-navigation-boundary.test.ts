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

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const featureRoot = join(
  desktopRoot,
  'src',
  'renderer',
  'features',
  'session-navigation',
);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|md)$/.test(entry.name) ? [path] : [];
  });
}

describe('Session Navigation feature boundary', () => {
  it('contains no Desktop global bridge or shell/process imports', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(featureRoot)) {
      const source = readFileSync(path, 'utf8');
      const name = relative(desktopRoot, path);
      if (source.includes('window.maka')) violations.push(`${name}: Desktop global`);
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const imported = match[1] ?? '';
        if (
          imported.includes('app-shell') ||
          imported.includes('/preload/') ||
          imported.includes('/main/')
        ) {
          violations.push(`${name}: ${imported}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it('is consumed outside the feature only through public entries', () => {
    const allowed = /\/features\/session-navigation\/(?:index|testing)(?:\.js)?$/;
    const violations: string[] = [];
    for (const root of [join(desktopRoot, 'src'), join(desktopRoot, 'stories')]) {
      for (const path of sourceFiles(root)) {
        if (path.startsWith(featureRoot)) continue;
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(
          /from\s+['"]([^'"]*features\/session-navigation[^'"]*)['"]/g,
        )) {
          const imported = match[1] ?? '';
          const normalized = imported.replace(/\\/g, '/');
          const explicitEntry = normalized.endsWith('/features/session-navigation')
            ? `${normalized}/index`
            : normalized;
          if (!allowed.test(explicitEntry)) {
            violations.push(`${relative(desktopRoot, path)}: ${imported}`);
          }
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it('keeps fake services out of the production entry', () => {
    const productionEntry = readFileSync(join(featureRoot, 'index.ts'), 'utf8');
    assert.equal(
      productionEntry.includes('createFakeSessionNavigationServices'),
      false,
    );
    assert.equal(productionEntry.includes("from './testing"), false);
  });

  it('keeps rail projection, persistence, and row mutation ownership out of AppShell', () => {
    const appShell = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'app-shell.tsx'),
      'utf8',
    );
    for (const forbidden of [
      'deriveSessionRail(',
      'deriveSessionRevisionNavigation(',
      'readSessionListViewMode(',
      'sessionRowActionRegistry',
      'window.maka.sessions.setFlagged',
      'window.maka.sessions.archive',
      'window.maka.sessions.unarchive',
      'window.maka.sessions.rename',
      'window.maka.sessions.remove',
    ]) {
      assert.equal(appShell.includes(forbidden), false, forbidden);
    }
    // The rail's state lives under its own provider, so AppShell holds no
    // controller at all: it renders the provider and reads back the projections
    // it needs for the palette, the titlebar, and the frame's width (#4109).
    assert.equal(appShell.includes('useSessionNavigationController'), false);
    assert.equal(appShell.includes('} = useSessionNavigationReads({'), true);
    assert.equal(appShell.includes('<SessionNavigationProvider'), true);
  });
});

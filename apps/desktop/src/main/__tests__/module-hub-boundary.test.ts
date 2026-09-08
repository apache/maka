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
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const featureRoot = join(
  desktopRoot,
  'src',
  'renderer',
  'features',
  'module-hub',
);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|md)$/.test(entry.name) ? [path] : [];
  });
}

describe('Module Hub feature boundary', () => {
  it('keeps Desktop globals and shell/process dependencies outside production feature code', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(featureRoot)) {
      if (path.endsWith(`${join('', 'testing.ts')}`)) continue;
      const source = readFileSync(path, 'utf8');
      const name = relative(desktopRoot, path);
      if (!path.endsWith('.md')) {
        if (source.includes('window.maka')) violations.push(`${name}: window.maka`);
        if (source.includes('navigator.')) violations.push(`${name}: navigator`);
      }
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

  it('is consumed outside the feature only through index or testing', () => {
    const allowed = /\/features\/module-hub\/(?:index|testing)(?:\.js)?$/;
    const violations: string[] = [];
    for (const root of [join(desktopRoot, 'src'), join(desktopRoot, 'stories')]) {
      for (const path of sourceFiles(root)) {
        if (path.startsWith(featureRoot)) continue;
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(
          /from\s+['"]([^'"]*features\/module-hub[^'"]*)['"]/g,
        )) {
          const imported = (match[1] ?? '').replace(/\\/g, '/');
          const explicitEntry = imported.endsWith('/features/module-hub')
            ? `${imported}/index`
            : imported;
          if (!allowed.test(explicitEntry)) {
            violations.push(`${relative(desktopRoot, path)}: ${imported}`);
          }
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it('keeps fakes out of the production entry', () => {
    const productionEntry = readFileSync(join(featureRoot, 'index.ts'), 'utf8');
    assert.equal(productionEntry.includes('createFakeModuleHub'), false);
    assert.equal(productionEntry.includes("from './testing"), false);
  });

  it('keeps module data, pages, nonce, bridges, and subscriptions out of AppShell', () => {
    const appShell = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'app-shell.tsx'),
      'utf8',
    );
    for (const forbidden of [
      'useAppShellModuleData',
      'useKeepSystemAwake',
      'createAppShellDailyReviewBridge',
      'createAppShellDailyReviewActions',
      'scheduledTaskCreateRequestNonce',
      'ModuleHubSelector',
      '<SkillsPage',
      '<ScheduledTasksPage',
      '<DailyReviewPage',
      '<McpPage',
      'refreshScheduledTasks',
      'refreshManagedSkillSources',
      'refreshBundledSkillCatalog',
    ]) {
      assert.equal(appShell.includes(forbidden), false, forbidden);
    }
    for (const forbidden of [
      'useModuleHubController(',
      'moduleHub.commands',
      'moduleHub.selectors',
      'moduleHub.host',
      '<ModuleHubHost model=',
    ]) {
      assert.equal(appShell.includes(forbidden), false, forbidden);
    }
    assert.equal(appShell.includes('<ModuleHub.ModuleHubProvider'), true);
    assert.equal(appShell.includes('<ModuleHub.ModuleHubHost />'), true);

    const effects = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'app-shell-effects.ts'),
      'utf8',
    );
    assert.equal(effects.includes('window.maka.scheduledTasks'), false);

    const commands = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'app-shell-command-actions.ts'),
      'utf8',
    );
    assert.equal(commands.includes('dailyReviewBridge'), false);
    assert.equal(commands.includes('saveDailyReviewMarkdown'), false);
    assert.equal(commands.includes('copyTodayDailyReview()'), true);
    assert.equal(commands.includes('pasteTodayDailyReview()'), true);
    assert.equal(commands.includes('saveTodayDailyReview()'), true);
  });
});

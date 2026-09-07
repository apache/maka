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

const desktopRoot = resolve(
  fileURLToPath(new URL('../../../', import.meta.url)),
);
const featureRoot = join(
  desktopRoot,
  'src',
  'renderer',
  'features',
  'workbar',
);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|md)$/.test(entry.name) ? [path] : [];
  });
}

describe('Workbar feature boundary', () => {
  it('contains no Desktop global bridge or shell/process imports', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(featureRoot)) {
      const source = readFileSync(path, 'utf8');
      const name = relative(desktopRoot, path);
      if (source.includes('window.maka')) violations.push(`${name}: Desktop global`);
      if (source.includes('session-message-settlement')) {
        violations.push(`${name}: Desktop transcript settlement`);
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

  it('is consumed outside the feature only through public entries', () => {
    // `stories` joins `index` and `testing` as a public entry: the surface it
    // exposes is only resolvable by a bundler, so Storybook can import it and
    // the node suites behind `testing` cannot.
    const allowed = /\/features\/workbar\/(?:index|testing|stories)(?:\.js)?$/;
    const violations: string[] = [];
    for (const root of [join(desktopRoot, 'src'), join(desktopRoot, 'stories')]) {
      for (const path of sourceFiles(root)) {
        if (path.startsWith(featureRoot)) continue;
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/from\s+['"]([^'"]*features\/workbar[^'"]*)['"]/g)) {
          const imported = match[1] ?? '';
          const normalized = imported.replace(/\\/g, '/');
          const explicitEntry = normalized.endsWith('/features/workbar')
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
    assert.equal(productionEntry.includes('createFakeWorkbarServices'), false);
    assert.equal(productionEntry.includes("from './testing"), false);
  });

  it('keeps Workbar topology and resource lifecycle out of AppShell', () => {
    const appShell = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'app-shell.tsx'),
      'utf8',
    );
    for (const forbidden of [
      'useWorkbarLayoutState',
      'terminalSessionWorkbarTabId',
      'pendingSideChatClose',
      'sideConversations',
      'window.maka.shellRuns.start',
    ]) {
      assert.equal(appShell.includes(forbidden), false, forbidden);
    }
    assert.equal(
      appShell.includes('<WorkbarHost model={workbar.host} />'),
      true,
    );
  });

  it('projects Work Board project identity through the controller-owned host model', () => {
    const appShell = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'app-shell.tsx'),
      'utf8',
    );
    const controller = readFileSync(
      join(featureRoot, 'controller', 'use-workbar-controller.ts'),
      'utf8',
    );
    const host = readFileSync(
      join(featureRoot, 'ui', 'workbar-host.tsx'),
      'utf8',
    );

    assert.equal(appShell.includes('projectId: currentProjectId'), true);
    assert.equal(
      appShell.includes('projectAliases: currentProject?.aliases ?? []'),
      true,
    );
    assert.equal(controller.includes('projectId: input.projectId'), true);
    assert.equal(
      controller.includes('projectAliases: input.projectAliases'),
      true,
    );
    assert.equal(
      host.includes('projectAliases={props.projectAliases}'),
      true,
    );
  });

  it('keeps Quote Companion catalog state and localized scroll copy at the seam', () => {
    const quotePanel = readFileSync(
      join(
        featureRoot,
        'tools',
        'side-chat',
        'quote-companion-panel.tsx',
      ),
      'utf8',
    );
    assert.equal(
      quotePanel.includes(
        'scrollToBottomLabel={copy.scrollToBottom}',
      ),
      true,
    );
    // The catalog reaches the panel through ComposerMentionsProvider rather
    // than through props (#4109), so what this guards is the context read, not
    // the prop names. Both facets still have to arrive together: a panel that
    // showed the skills without their loading verdict would advertise a
    // catalog it cannot honour.
    assert.equal(quotePanel.includes('useComposerMentionsContext()'), true);
    assert.equal(
      quotePanel.includes(
        'mentionSkillsUnavailable={mentions?.mentionSkillsUnavailable}',
      ),
      true,
    );
    assert.equal(
      quotePanel.includes('mentionSkillsLoading={mentions?.mentionSkillsLoading}'),
      true,
    );
  });
});

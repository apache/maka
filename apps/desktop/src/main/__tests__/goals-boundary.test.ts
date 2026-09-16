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
const repoRoot = resolve(desktopRoot, '..', '..');
const featureRoot = join(desktopRoot, 'src', 'renderer', 'features', 'goals');

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|md)$/.test(entry.name) ? [path] : [];
  });
}

describe('Goals feature boundary', () => {
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
    const productionEntry = /\/features\/goals\/index(?:\.js)?$/;
    const testingEntry = /\/features\/goals\/testing(?:\.js)?$/;
    const violations: string[] = [];
    for (const root of [join(desktopRoot, 'src'), join(desktopRoot, 'stories')]) {
      for (const path of sourceFiles(root)) {
        if (path.startsWith(featureRoot)) continue;
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/from\s+['"]([^'"]*features\/goals[^'"]*)['"]/g)) {
          const imported = match[1] ?? '';
          const normalized = imported.replace(/\\/g, '/');
          const explicitEntry = normalized.endsWith('/features/goals')
            ? `${normalized}/index`
            : normalized;
          const consumer = relative(desktopRoot, path).replace(/\\/g, '/');
          const testConsumer =
            consumer.includes('/__tests__/') || consumer.startsWith('stories/');
          if (
            !productionEntry.test(explicitEntry) &&
            !(testConsumer && testingEntry.test(explicitEntry))
          ) {
            violations.push(`${relative(desktopRoot, path)}: ${imported}`);
          }
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it('keeps fake services out of the production entry', () => {
    const productionEntry = readFileSync(join(featureRoot, 'index.ts'), 'utf8');
    assert.equal(productionEntry.includes('createFakeGoalServices'), false);
    assert.equal(productionEntry.includes("from './testing"), false);
    assert.equal(productionEntry.includes('useGoalController'), false);
  });

  it('keeps the controller owned by GoalProvider and out of renderer roots', () => {
    const controllerOwner = join(featureRoot, 'ui', 'goal-provider.tsx');
    const consumers: string[] = [];
    for (const path of sourceFiles(join(desktopRoot, 'src', 'renderer'))) {
      if (!/\.tsx?$/.test(path) || path.endsWith('use-goal-controller.ts')) continue;
      const source = readFileSync(path, 'utf8');
      if (/\buseGoalController\s*\(/.test(source)) {
        consumers.push(relative(desktopRoot, path));
      }
    }
    assert.deepEqual(consumers, [relative(desktopRoot, controllerOwner)]);
  });

  it('keeps the controller module behind GoalProvider and the testing entry', () => {
    const importers: string[] = [];
    for (const path of sourceFiles(featureRoot)) {
      if (!/\.tsx?$/.test(path)) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (match[1]?.includes('controller/use-goal-controller')) {
          importers.push(relative(desktopRoot, path));
        }
      }
    }
    assert.deepEqual(importers.sort(), [
      'src/renderer/features/goals/testing.ts',
      'src/renderer/features/goals/ui/goal-provider.tsx',
    ]);
  });

  it('binds separate projection contexts at the authoritative UI readers', () => {
    const provider = readFileSync(
      join(featureRoot, 'ui', 'goal-provider.tsx'),
      'utf8',
    );
    for (const required of [
      'ChatViewGoalProjectionProvider,',
      'ComposerGoalProjectionProvider,',
      '<ComposerGoalProjectionProvider value={composer}>',
      '<ChatViewGoalProjectionProvider value={indicator}>',
    ]) {
      assert.equal(provider.includes(required), true, required);
    }
    assert.equal(provider.includes('cloneElement'), false);

    const composer = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'chat-composer-region.tsx'),
      'utf8',
    );
    const messageSurface = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'chat-message-surface.tsx'),
      'utf8',
    );
    const uiComposer = readFileSync(
      join(repoRoot, 'packages', 'ui', 'src', 'composer.tsx'),
      'utf8',
    );
    const uiChatView = readFileSync(
      join(repoRoot, 'packages', 'ui', 'src', 'chat-view.tsx'),
      'utf8',
    );
    const uiGoalProjection = readFileSync(
      join(repoRoot, 'packages', 'ui', 'src', 'goal-projection-context.ts'),
      'utf8',
    );
    for (const [source, required] of [
      [composer, 'ComposerGoalProjectionConsumer,'],
      [composer, '<ComposerGoalProjectionConsumer>'],
      [composer, 'goalActive={goalProjection.goalActive}'],
      [composer, 'onSetGoal={goalProjection.onSetGoal}'],
      [messageSurface, 'ChatViewGoalProjectionConsumer,'],
      [messageSurface, '<ChatViewGoalProjectionConsumer>'],
      [messageSurface, 'goalIndicator={goalProjection.goalIndicator}'],
      [uiComposer, 'export interface ComposerGoalProps {'],
      [uiComposer, '} & ComposerGoalProps'],
      [uiChatView, 'export interface ChatViewGoalIndicatorProps {'],
      [uiChatView, '} & ChatViewGoalIndicatorProps)'],
      [uiGoalProjection, 'export interface ComposerGoalProjection {'],
      [uiGoalProjection, "ComposerGoalProps['goalActive']"],
      [uiGoalProjection, "ComposerGoalProps['onSetGoal']"],
      [uiGoalProjection, 'export interface ChatViewGoalProjection {'],
      [uiGoalProjection, "ChatViewGoalIndicatorProps['goalIndicator']"],
      [uiGoalProjection, 'export const ComposerGoalProjectionConsumer ='],
      [uiGoalProjection, 'export const ChatViewGoalProjectionConsumer ='],
    ] as const) {
      assert.equal(source.includes(required), true, required);
    }
    assert.equal(composer.includes("from './features/goals"), false);
    assert.equal(messageSurface.includes("from './features/goals"), false);
    assert.equal(composer.includes('useComposerGoalProjection'), false);
    assert.equal(messageSurface.includes('useChatViewGoalProjection'), false);
    assert.equal(uiComposer.includes('goal-projection-context'), false);
    assert.equal(uiChatView.includes('goal-projection-context'), false);
  });

  it('keeps Goal projection consumers exclusive to the authorized renderer leaves', () => {
    const rendererRoot = join(desktopRoot, 'src', 'renderer');
    const productionSources = sourceFiles(rendererRoot).filter((path) => {
      const name = relative(desktopRoot, path).replace(/\\/g, '/');
      return /\.tsx?$/.test(path) && !name.includes('/__tests__/');
    });
    const importersOf = (name: string) =>
      productionSources
        .filter((path) => readFileSync(path, 'utf8').includes(name))
        .map((path) => relative(desktopRoot, path).replace(/\\/g, '/'))
        .sort();

    assert.deepEqual(importersOf('ComposerGoalProjectionConsumer'), [
      'src/renderer/chat-composer-region.tsx',
    ]);
    assert.deepEqual(importersOf('ChatViewGoalProjectionConsumer'), [
      'src/renderer/chat-message-surface.tsx',
    ]);
    assert.deepEqual(importersOf('useComposerGoalProjection'), []);
    assert.deepEqual(importersOf('useChatViewGoalProjection'), []);

    const composer = readFileSync(
      join(rendererRoot, 'chat-composer-region.tsx'),
      'utf8',
    );
    const messageSurface = readFileSync(
      join(rendererRoot, 'chat-message-surface.tsx'),
      'utf8',
    );
    for (const omitted of ["| 'goalActive'", "| 'onSetGoal'"]) {
      assert.equal(composer.includes(omitted), true, omitted);
    }
    assert.equal(
      messageSurface.includes("| 'goalIndicator'"),
      true,
      'goalIndicator',
    );
  });

  it('keeps Goal state, controls, and dialog reads below AppShell', () => {
    const appShell = readFileSync(
      join(desktopRoot, 'src', 'renderer', 'app-shell.tsx'),
      'utf8',
    );
    for (const forbidden of [
      'window.maka.goal',
      'useSessionGoal',
      'pendingGoalControlSessionIdsRef',
      'goalDialogSessionId',
      'setGoalDialogSessionId',
      'useGoalController',
      'goals.commands',
      'goals.selectors',
      'goals.host',
      '<GoalHost model=',
      'onSetGoal=',
      'goalActive=',
      'goalIndicator=',
      '<Goals.GoalComposerBoundary',
      '<Goals.GoalIndicatorBoundary',
      'ComposerGoalProjectionConsumer',
      'ChatViewGoalProjectionConsumer',
      'useComposerGoalProjection',
      'useChatViewGoalProjection',
    ]) {
      assert.equal(appShell.includes(forbidden), false, forbidden);
    }
    for (const required of [
      '<Goals.GoalProvider',
      '<Goals.GoalHost />',
    ]) {
      assert.equal(appShell.includes(required), true, required);
    }
  });
});

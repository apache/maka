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
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

// These are dependency guards, not a replacement for behavioral contract tests.
// Keep the check independent of TypeScript's version-specific compiler API.
function dependencies(source: string): string[] {
  return [
    ...source.matchAll(/\b(?:from|import)\s*['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/gu),
  ].map((match) => match[1]!);
}

test('Session and Tool persistence contracts do not import concrete storage implementations', async () => {
  for (const name of ['session-store-contract', 'runtime-event-store-contract']) {
    const source = await readFile(new URL(`../../src/${name}.ts`, import.meta.url), 'utf8');
    for (const specifier of dependencies(source)) {
      assert.ok(
        specifier.startsWith('@maka/core/') || specifier === './message-admission-store.js',
        `${name}: implementation dependency ${specifier} must stay behind composition`,
      );
    }
  }
  const execution = await readFile(
    new URL('../../src/execution-stores.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    execution,
    /from\s*['"]\.\/sqlite-(?:runtime-store|session-metadata-store)\.js['"]/u,
  );
});

test('production Runtime and Host use persistence contracts, with writer construction owned by composition', async () => {
  for (const directory of [
    new URL('../../../runtime/src/', import.meta.url),
    new URL('../../../runtime-host/src/server/', import.meta.url),
  ]) {
    for (const file of await productionSources(directory)) {
      const source = await readFile(file, 'utf8');
      for (const specifier of dependencies(source)) {
        assert.ok(
          !/^(?:node:sqlite|sqlite3?|better-sqlite3)$/u.test(specifier) &&
            !/\/(?:sqlite-[^/]+|session-store|agent-run-store|runtime-event-persistence)(?:\.js)?$/u.test(
              specifier,
            ),
          `${file.pathname}: consume execution-stores, not ${specifier}`,
        );
      }
      assert.doesNotMatch(
        source,
        /\b(?:createSqlite\w+|openSqlite\w+|createSessionStore)\b/u,
        `${file.pathname}: concrete adapter construction belongs to storage composition`,
      );
      if (file.pathname.endsWith('/runtime-host/src/server/execution-composition.ts')) continue;
      assert.doesNotMatch(
        source,
        /\b(?:openStorageWriterComposition|openInteractiveExecutionStoresForWrite)\b/u,
        `${file.pathname}: receive owned writers from composition`,
      );
    }
  }
});

async function productionSources(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'test-only') continue;
    if (entry.isDirectory())
      files.push(...(await productionSources(new URL(`${entry.name}/`, directory))));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      files.push(new URL(entry.name, directory));
  }
  return files;
}

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
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { bareCssImportSpecifiers, installedInstances } from './third-party-closure.mjs';

// The bundle recorder cannot see a package reached only through a CSS
// `@import` of pure rules — Vite inlines it at transform time, so it never
// becomes a module, and with no `url()` asset it emits nothing either. The
// notice generator therefore reads the stylesheets, and this is the reader.

describe('bareCssImportSpecifiers', () => {
  test('finds package names behind every @import spelling', () => {
    const css = `
@import "normalize.css";
@import 'modern-css-reset';
@import url("some-pkg/theme.css");
@import "@scope/pkg/dist/base.css" layer(components);
@import "@scope/only-root";
@import "tokens.css" screen and (min-width: 40em);
@import url(unquoted-pkg/base.css);
@import url( spaced-pkg );
`;
    assert.deepEqual(bareCssImportSpecifiers(css).sort(), [
      '@scope/only-root',
      '@scope/pkg',
      'modern-css-reset',
      'normalize.css',
      'some-pkg',
      'spaced-pkg',
      'tokens.css',
      'unquoted-pkg',
    ]);
  });

  test('ignores anything that is not a package name', () => {
    const css = `
@import "./cascade-layers.css";
@import "../shared/base.css";
@import "/absolute.css";
@import url("https://fonts.example/font.css");
@import url("data:text/css,body{}");
`;
    assert.deepEqual(bareCssImportSpecifiers(css), []);
  });

  test('reports a scoped package once however deeply it is imported', () => {
    const css = `
@import "@astryxdesign/core/reset.css";
@import "@astryxdesign/core/astryx.css" layer(astryx-components);
`;
    assert.deepEqual(bareCssImportSpecifiers(css), ['@astryxdesign/core']);
  });
});

// `npm ls --long --json` reports each installed instance with its real
// directory. The artifact-budget ledger is read at that granularity, because
// electron-builder copies every instance, not every name.
describe('installedInstances', () => {
  const root = join('/', 'repo');
  const at = (...segments) => join(root, ...segments);

  test('lists a nested copy as its own instance, alongside the hoisted one', () => {
    const tree = {
      alpha: {
        version: '1.0.0',
        path: at('node_modules', 'alpha'),
        dependencies: {
          shared: {
            version: '2.0.0',
            path: at('node_modules', 'alpha', 'node_modules', 'shared'),
            dependencies: {
              only_via_nested: { version: '1.0.0', path: at('node_modules', 'only_via_nested') },
            },
          },
        },
      },
      shared: { version: '1.0.0', path: at('node_modules', 'shared') },
    };

    assert.deepEqual(installedInstances(tree, root), [
      'node_modules/alpha/node_modules/shared@2.0.0',
      'node_modules/alpha@1.0.0',
      'node_modules/only_via_nested@1.0.0',
      'node_modules/shared@1.0.0',
    ]);
  });

  test('a deduped reference to the same instance counts once', () => {
    const shared = { version: '1.0.0', path: at('node_modules', 'shared') };
    const tree = {
      alpha: { version: '1.0.0', path: at('node_modules', 'alpha'), dependencies: { shared } },
      shared,
    };

    assert.deepEqual(installedInstances(tree, root), [
      'node_modules/alpha@1.0.0',
      'node_modules/shared@1.0.0',
    ]);
  });

  test('an optional peer that nothing installed ships nothing', () => {
    const tree = {
      ws: {
        version: '8.0.0',
        path: at('node_modules', 'ws'),
        dependencies: { bufferutil: {}, 'utf-8-validate': {} },
      },
    };

    assert.deepEqual(installedInstances(tree, root), ['node_modules/ws@8.0.0']);
  });

  test('a workspace package is recorded at its node_modules link', () => {
    const tree = {
      '@maka/runtime': {
        version: '0.1.0',
        path: at('node_modules', '@maka', 'runtime'),
        dependencies: {
          undici: { version: '8.0.0', path: at('packages', 'runtime', 'node_modules', 'undici') },
        },
      },
    };

    assert.deepEqual(installedInstances(tree, root), [
      'node_modules/@maka/runtime@0.1.0',
      'packages/runtime/node_modules/undici@8.0.0',
    ]);
  });
});

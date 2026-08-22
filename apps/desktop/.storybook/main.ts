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

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig, type UserConfig } from 'vite';
import { dependencyPatchesCachePlugin } from '../vite-dependency-patches.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_SRC = resolve(REPO_ROOT, 'packages/ui/src');
const STORYBOOK_NODE_CRYPTO_BOUNDARY = resolve(
  REPO_ROOT,
  'apps/desktop/.storybook/node-crypto-boundary.ts',
);

const config: StorybookConfig = {
  stories: [
    '../../../packages/ui/stories/**/*.stories.@(ts|tsx)',
    resolve(REPO_ROOT, 'apps/desktop/stories/**/*.stories.@(ts|tsx)'),
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  async viteFinal(baseConfig) {
    return mergeConfig(baseConfig, {
      plugins: [dependencyPatchesCachePlugin(REPO_ROOT)],
      resolve: {
        alias: [
          // @maka/core's public barrel also exports the Node-only runtime
          // boundary. Product stories do not execute it, but ESM re-exports
          // still evaluate that module in the preview. Keep Storybook's
          // browser boundary explicit and fail closed if a story ever tries
          // to hash runtime state.
          { find: 'node:crypto', replacement: STORYBOOK_NODE_CRYPTO_BOUNDARY },
          { find: '@maka/ui/icons', replacement: resolve(UI_SRC, 'icons.tsx') },
          { find: '@maka/ui/artifact-preview-registry', replacement: resolve(UI_SRC, 'artifact-preview-registry.ts') },
          { find: '@maka/ui/assistant-stream', replacement: resolve(UI_SRC, 'assistant-stream.ts') },
          { find: '@maka/ui/maka-uri', replacement: resolve(UI_SRC, 'maka-uri.ts') },
          { find: /^@maka\/ui$/, replacement: resolve(UI_SRC, 'index.ts') },
        ],
      },
    } satisfies UserConfig);
  },
};

export default config;

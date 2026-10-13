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

import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { alias, source } from './main-api.mjs';
const kind = process.argv[2] ?? 'ui';
const content =
  kind === 'ui'
    ? `export {ClientPluginRuntime,MakaClientRoot,MakaClientRootOutlet} from ${JSON.stringify(join(source, 'packages/ui/src/client-plugin-runtime.tsx'))}; export {MakaClientSlotOutlet,MakaClientPluginSdkModule} from ${JSON.stringify(join(source, 'packages/ui/src/client-plugin-slots.tsx'))};`
    : `export {createTestAiSdkBackend} from ${JSON.stringify(join(source, 'packages/runtime/src/__tests__/execution-boundary-test-helpers.ts'))};
export {getAIModel} from ${JSON.stringify(join(source, 'packages/runtime/src/model-factory.ts'))};
export {createSessionEventMapMemory,mapSessionEventToRuntimeEvent} from ${JSON.stringify(join(source, 'packages/runtime/src/session-event-runtime-mapper.ts'))};`;
await build({
  stdin: { contents: content, resolveDir: process.cwd() },
  outfile: '.artifacts/' + kind + '-api.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  plugins: [
    {
      name: 'generated-model-data',
      setup(b) {
        b.onResolve({ filter: /model-(metadata|pricing)\.generated\.js$/ }, (a) => ({
          path: resolve('.artifacts', a.path.split('/').pop().replace('.js', '.ts')),
        }));
      },
    },
    alias,
  ],
  nodePaths: [
    resolve('node_modules'),
    join(source, 'node_modules'),
    ...(process.env.MAKA_NODE_MODULES ? [resolve(process.env.MAKA_NODE_MODULES)] : []),
  ],
  banner: {
    js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);',
  },
});

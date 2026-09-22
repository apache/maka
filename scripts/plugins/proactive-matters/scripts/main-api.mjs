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
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const source = resolve(
  process.env.MAKA_SOURCE ?? fileURLToPath(new URL('../../../../', import.meta.url)),
);
export const alias = {
  name: 'maka-main-source',
  setup(b) {
    b.onResolve({ filter: /^@maka\// }, (args) => {
      const [, pkg, sub] = args.path.match(/^@maka\/([^/]+)(?:\/(.*))?$/);
      const directory = join(source, 'packages', pkg);
      const p = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      const value = p.exports?.[sub ? './' + sub : '.'];
      const output = typeof value === 'string' ? value : (value?.import ?? value?.default);
      let path = output
        ? join(directory, output.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
        : join(directory, 'src', sub ?? 'index.ts');
      if (!existsSync(path)) throw new Error('Missing current main source: ' + path);
      return { path };
    });
  },
};
const exports = [
  ['runtime', 'plugin-kernel', 'Context'],
  ['runtime', 'plugin-agent-service', 'PluginAgentService'],
  ['runtime', 'plugin-tool-service', 'PluginToolService'],
  ['runtime', 'plugin-system-prompt-service', 'PluginSystemPromptService'],
  ['runtime', 'plugin-data-services', 'PluginStorageService'],
  ['runtime', 'plugin-client-bridge-service', 'PluginClientBridgeService'],
  ['runtime', 'plugin-composition-loader', 'MakaCompositionLoader'],
  ['runtime-host', 'server/plugin-data-runtime', 'HostPluginDataRuntime'],
  ['runtime-host', 'server/plugin-platform', 'HostPluginPlatform'],
  ['runtime-host', 'server/extension-bundle', 'exportExtensionBundle'],
];
mkdirSync('.artifacts', { recursive: true });
await build({
  stdin: {
    contents: exports
      .map(
        ([p, m, n]) =>
          `export { ${n} } from ${JSON.stringify(join(source, 'packages', p, 'src', m + '.ts'))};`,
      )
      .join('\n'),
    resolveDir: process.cwd(),
  },
  outfile: '.artifacts/main-api.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [alias],
  nodePaths: [
    resolve('node_modules'),
    join(source, 'node_modules'),
    ...(process.env.MAKA_NODE_MODULES ? [resolve(process.env.MAKA_NODE_MODULES)] : []),
  ],
  banner: {
    js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);',
  },
});

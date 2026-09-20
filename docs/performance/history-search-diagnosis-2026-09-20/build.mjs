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
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!process.argv[2]) throw new Error('Pass a temporary output directory');
const repo = process.cwd();
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
if (!existsSync(join(out, 'node_modules'))) {
  symlinkSync(join(repo, 'node_modules'), join(out, 'node_modules'), 'dir');
}
const exports = [
  ['ClientSessionSubscription', 'packages/runtime-host/src/client/session-subscription.ts'],
  ['runThreadSearch', 'packages/core/src/thread-search.ts'],
  ['decodeStoredMessage', 'packages/core/src/session.ts'],
  ['createDefaultRuntimePolicy', 'packages/core/src/runtime-policy.ts'],
  ['registerRuntimeHostSearchIpc', 'apps/desktop/src/main/runtime-host-search-ipc-main.ts'],
  [
    'createSessionTranscriptBootstrap, readSessionTranscriptPage',
    'packages/runtime-host/src/server/session-transcript-pager.ts',
  ],
];
await build({
  stdin: {
    contents: exports
      .map(([names, path]) => `export { ${names} } from ${JSON.stringify(join(repo, path))};`)
      .join('\n'),
    loader: 'ts',
    resolveDir: repo,
    sourcefile: 'history-search-diagnosis.ts',
  },
  outfile: join(out, 'source.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: 'inline',
  banner: {
    js: "import { createRequire as __diagnosisRequire } from 'node:module'; const require = __diagnosisRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'workspace-sources',
      setup(builder) {
        builder.onResolve({ filter: /^@maka\// }, ({ path }) => {
          const [, name, ...rest] = path.split('/');
          const base = join(repo, 'packages', name);
          const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
          const exported = pkg.exports[rest.length ? `./${rest.join('/')}` : '.'];
          if (typeof exported !== 'string') throw new Error(`Unsupported export ${path}`);
          const target = resolve(
            base,
            exported.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts'),
          );
          if (existsSync(target)) return { path: target };
          if (existsSync(`${target}x`)) return { path: `${target}x` };
          throw new Error(`Missing source ${target}`);
        });
      },
    },
  ],
});
const files = [
  ...new Set([
    ...exports.map(([, path]) => path),
    'apps/desktop/src/main/runtime-host-client.ts',
    'packages/runtime-host/src/protocol/session-transcript.ts',
    'packages/runtime-host/src/server/session-transcript-reader.ts',
  ]),
];
writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify(
    {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sourceSha256: Object.fromEntries(
        files.map((path) => [
          path,
          createHash('sha256')
            .update(readFileSync(join(repo, path)))
            .digest('hex'),
        ]),
      ),
    },
    null,
    2,
  ) + '\n',
);
console.log(join(out, 'source.mjs'));

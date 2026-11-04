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

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runtimeDirectory } from './runtime.mjs';
import { cargoLicenseRecord, renderNoticeRecords } from '../rust/notices.mjs';

/** Generate evidence for review; this does not add a reviewed supplement entry. */
export async function runtimeNotices({
  root,
  checkout,
  source,
  target,
  metadata,
  v8Notices,
  toolchain,
  directory,
  env = process.env,
}) {
  const catalog = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const rootPackage = metadata.packages.find((pkg) => pkg.name === 'denort');
  if (rootPackage?.version !== source.version)
    throw new Error('Runtime notice source version differs');
  const pending = [rootPackage.id];
  const seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps)
      if (dep.dep_kinds.some((kind) => kind.kind !== 'dev')) pending.push(dep.pkg);
  }
  const packages = [...seen]
    .map((id) => catalog.get(id))
    .sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));
  const supplements = JSON.parse(
    await readFile(join(root, 'scripts/rust/notices-sources.json'), 'utf8'),
  );
  const records = [];
  for (const pkg of packages) {
    // Deno source is covered below; V8 comes from the exact reviewed build, not its crate's incomplete license list.
    if (pkg.source && pkg.name !== 'v8')
      records.push(await cargoLicenseRecord(root, pkg, supplements));
  }
  const denoTexts = [];
  for (const path of [
    'LICENSE.md',
    'ext/webgpu/LICENSE.md',
    'cli/tsc/dts/node/LICENSE',
    'cli/tsc/dts/node/undici/LICENSE',
  ])
    denoTexts.push({
      source: `${source.repository}/blob/${source.revision}/${path}`,
      content: await readFile(join(checkout, path), 'utf8'),
    });
  denoTexts.push({
    source: `${source.repository}/tree/${source.revision} (original runtime source headers)`,
    content: await readFile(
      join(root, 'scripts/rust/licenses', `deno-${source.version}-source-notices.txt`),
      'utf8',
    ),
  });
  records.push({
    component: `Deno ${source.version}: ${packages
      .filter((pkg) => !pkg.source)
      .map((pkg) => pkg.name + '@' + pkg.version)
      .join(', ')}`,
    texts: denoTexts,
  });
  records.push({
    component: 'V8 linked into controlled denort',
    texts: [{ source: 'Maka reviewed V8 build (source and GN graph below)', content: v8Notices }],
  });
  const sysroot = execFileSync(toolchain.rustc, ['--print', 'sysroot'], {
    cwd: checkout,
    env,
    encoding: 'utf8',
  }).trim();
  const compiler = execFileSync(toolchain.rustc, ['--version', '--verbose'], {
    cwd: checkout,
    env,
    encoding: 'utf8',
  }).trim();
  if (compiler !== toolchain.version)
    throw new Error('Runtime notice compiler differs from build receipt');
  records.push({
    component: compiler,
    texts: [
      {
        source: 'Rust toolchain share/doc/rust/COPYRIGHT-library.html',
        content: await readFile(join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'), 'utf8'),
      },
    ],
  });
  await writeFile(
    join(directory, 'license-inputs.json'),
    JSON.stringify(
      {
        source,
        target,
        packages: packages.map((pkg) => ({
          name: pkg.name,
          version: pkg.version,
          source: pkg.source,
          license: pkg.license,
        })),
        compiler,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(join(directory, 'license-records.json'), JSON.stringify(records, null, 2) + '\n');
  const { content } = await renderNoticeRecords(root, records);
  const document = join(directory, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(
    document,
    `Controlled Deno runtime ${source.version}\nTarget: ${target}\nSource: ${source.url}\nSource SHA-256: ${source.sha256}\n\n` +
      content,
  );
  return document;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { target: { type: 'string' } } });
  if (!values.target)
    throw new Error(
      'Usage: runtime-notices.mjs --target TRIPLE (after the controlled runtime build)',
    );
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = join(runtimeDirectory(), values.target);
  const { source, target, toolchain } = JSON.parse(
    await readFile(join(directory, 'receipt.json'), 'utf8'),
  );
  if (target !== values.target) throw new Error('Runtime notice target differs from build receipt');
  console.log(
    await runtimeNotices({
      root,
      directory,
      source,
      target,
      toolchain,
      checkout: join(runtimeDirectory(), 'source', source.sha256, 'deno'),
      metadata: JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')),
      v8Notices: await readFile(join(directory, 'V8_NOTICES.txt'), 'utf8'),
      env: { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? 'stable' },
    }),
  );
}

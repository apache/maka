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
import { createHash } from 'node:crypto';
import { glob, readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nativeCliTargets } from './pack-cli.mjs';
import { rustTarget } from './build-cli.mjs';
import { licenseFiles, licenseName } from './license-files.mjs';
import { licenseDownloader } from './license-source.mjs';
import { uiCompiler } from './product.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const documentPath = 'products/maka/cli/THIRD_PARTY_NOTICES.txt';
const manifestPath = 'products/maka/cli/notices.json';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function inputs(root) {
  const names = [
    'Cargo.toml',
    'Cargo.lock',
    'package.json',
    'package-lock.json',
    'scripts/apply-dependency-patches.mjs',
    'scripts/rust/notices.mjs',
    'products/maka/bundle/scripts/build.mjs',
    'products/maka/bundle/package.json',
    'products/maka/cli/build/main.rs',
    'products/maka/cli/build/product.rs',
    'tools/ui-build/src/lib.rs',
    'tools/ui-build/src/main.rs',
    'scripts/setup.mjs',
    'scripts/rust/cargo.mjs',
    'scripts/rust/product.mjs',
    'scripts/rust/notices-sources.json',
    'platform/computer-use/THIRD_PARTY_NOTICES',
    'scripts/rust/v8-source.json',
    'scripts/rust/build-v8.mjs',
    'scripts/rust/compile-v8.mjs',
    'scripts/rust/license-files.mjs',
    'scripts/rust/license-source.mjs',
    'scripts/rust/v8-prebuilt.mjs',
    'scripts/rust/v8-prebuilts.json',
    'scripts/rust/v8-cache.mjs',
    'scripts/rust/v8-notices.mjs',
  ];
  for await (const entry of glob(
    [
      'platform/**/Cargo.toml',
      'plugins/**/Cargo.toml',
      'products/**/Cargo.toml',
      'tools/**/Cargo.toml',
      'platform/js-runtime/third-party/**/*',
      'products/maka/bundle/src/**/*.ts',
      'products/maka/bundle/package-inputs.json',
      'plugins/**/*.ts',
      'plugins/**/*.mjs',
      'scripts/plugins/*.mjs',
      'packages/plugin-sdk/src/**/*.ts',
      'patches/*.patch',
      'third-party/**/*',
    ],
    { cwd: root, withFileTypes: true },
  )) {
    if (entry.isFile())
      names.push(relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  }
  for (const entry of Object.values(
    JSON.parse(await readFile(join(root, 'scripts/rust/notices-sources.json'), 'utf8')),
  ).flat()) {
    if (entry.file) names.push(entry.file);
  }
  return Object.fromEntries(
    await Promise.all(
      [...new Set(names)]
        .sort()
        .map(async (name) => [name, hash(await readFile(join(root, name)))]),
    ),
  );
}

/** Release builds use only the reviewed, source-bound snapshot; no license downloads. */
export async function verifyNotices(root = repository) {
  const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'));
  const actual = await inputs(root);
  const document = await readFile(join(root, documentPath));
  if (
    JSON.stringify(manifest.inputs) !== JSON.stringify(actual) ||
    manifest.sha256 !== hash(document)
  ) {
    throw new Error(
      'Third-party notices are stale; run node scripts/rust/notices.mjs generate and review the changes',
    );
  }
  return join(root, documentPath);
}

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: Infinity });
}

export async function generateNotices(root = repository) {
  const groups = new Map();
  const download = licenseDownloader(root);
  const supplements = JSON.parse(
    await readFile(join(root, 'scripts/rust/notices-sources.json'), 'utf8'),
  );
  function add(component, source, content) {
    content = content.replaceAll('\r\n', '\n').trim() + '\n';
    if (!content.trim() || content.includes('\0'))
      throw new Error('Invalid license text: ' + source);
    const key = hash(content);
    const group = groups.get(key) ?? { content, components: new Set(), sources: new Set() };
    group.components.add(component);
    group.sources.add(source);
    groups.set(key, group);
  }
  // The native browser host embeds only Playwright's published injected script,
  // outside Cargo and the JavaScript bundle dependency graphs.
  const playwrightDirectory = join(root, 'third-party/playwright');
  const playwright = JSON.parse(await readFile(join(playwrightDirectory, 'upstream.json'), 'utf8'));
  const playwrightComponent = `${playwright.registry_package}@${playwright.registry_version} (${playwright.license}; vendored injected script)`;
  for (const file of ['injected.js', 'LICENSE', 'NOTICE', 'ThirdPartyNotices.txt']) {
    const content = await readFile(join(playwrightDirectory, file));
    if (hash(content) !== playwright.files[file])
      throw new Error(`Vendored Playwright ${file} does not match upstream.json`);
    if (file !== 'injected.js')
      add(
        playwrightComponent,
        `${playwright.archive.url} (SHA-256 ${playwright.archive.sha256}) :: package/${file}`,
        content.toString('utf8'),
      );
  }
  const upstream = new Map();
  async function upstreamFiles(pkg, directory, provenance) {
    const git = provenance
      ? new URL(provenance.repository + '#' + provenance.revision)
      : pkg.source?.startsWith('git+')
        ? new URL(pkg.source.slice(4))
        : undefined;
    const vcs = git
      ? undefined
      : JSON.parse(await readFile(join(directory, '.cargo_vcs_info.json'), 'utf8'));
    const repo = /^https?:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:[/?]|$)/.exec(
      git ? git.origin + git.pathname : (pkg.repository ?? ''),
    )?.[1];
    const sha = git ? git.hash.slice(1) : vcs.git?.sha1;
    if (!repo || !/^[a-f0-9]{40}$/.test(sha))
      throw new Error('Missing pinned license source for ' + pkg.name);
    const key = repo + '/' + sha;
    if (!upstream.has(key))
      upstream.set(
        key,
        (async () => {
          const entries = JSON.parse(run('gh', ['api', `repos/${repo}/contents?ref=${sha}`], root));
          const licenses = entries.filter(
            (entry) => entry.type === 'file' && licenseName(entry.name),
          );
          for (const entry of entries.filter(
            (entry) => entry.type === 'dir' && /^licen[cs]es?$/i.test(entry.name),
          )) {
            licenses.push(
              ...JSON.parse(
                run('gh', ['api', `repos/${repo}/contents/${entry.path}?ref=${sha}`], root),
              ).filter((entry) => entry.type === 'file'),
            );
          }
          if (!licenses.length) throw new Error('No upstream license files for ' + key);
          return Promise.all(
            licenses.map(async (entry) => {
              const url = `https://raw.githubusercontent.com/${repo}/${sha}/${entry.path}`;
              return [url, await download(url)];
            }),
          );
        })(),
      );
    return upstream.get(key);
  }
  const packages = new Map();
  for (const platform of Object.values(nativeCliTargets)) {
    const metadata = JSON.parse(
      run(
        'cargo',
        [
          'metadata',
          '--locked',
          '--format-version',
          '1',
          '--filter-platform',
          rustTarget(platform.os, platform.cpu),
        ],
        root,
      ),
    );
    const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
    const catalog = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
    const pending = ['maka-cli', 'maka-desktop-shell', 'maka-python-runtime'].map(
      (name) => metadata.packages.find((pkg) => pkg.name === name).id,
    );
    const seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const pkg = catalog.get(id);
      if (
        pkg.source ||
        relative(root, pkg.manifest_path).replaceAll('\\', '/').startsWith('third-party/')
      )
        packages.set(id, pkg);
      for (const dependency of nodes.get(id).deps) {
        if (dependency.dep_kinds.some((kind) => kind.kind !== 'dev')) pending.push(dependency.pkg);
      }
    }
  }
  const failures = [];
  for (const pkg of [...packages.values()].sort((a, b) =>
    (a.name + a.version).localeCompare(b.name + b.version),
  )) {
    try {
      const component =
        `${pkg.name}@${pkg.version} (${pkg.license ?? 'MIT; see upstream notice'})` +
        (pkg.authors.length ? `; authors declared by package: ${pkg.authors.join(', ')}` : '');
      const directory = dirname(pkg.manifest_path);
      let source = pkg.source;
      let provenance;
      if (!source) {
        const vendored = relative(root, directory)
          .replaceAll('\\', '/')
          .split('/')
          .slice(0, 2)
          .join('/');
        provenance = JSON.parse(await readFile(join(root, vendored, 'upstream.json'), 'utf8'));
        source = `${provenance.repository}#${provenance.revision} (adapted; ${relative(root, directory).replaceAll('\\', '/')})`;
      } else if (source.startsWith('registry+')) {
        source = `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`;
      }
      let local = await licenseFiles(directory);
      if (pkg.license_file) {
        const license = resolve(directory, pkg.license_file);
        if (!local.includes(license)) local.push(license);
      }
      let references = false;
      local = (
        await Promise.all(
          local.map(async (file) => {
            const text = await readFile(file, 'utf8');
            if (text.trim().length < 80) {
              references ||= text.includes('../');
              return null;
            }
            return file;
          }),
        )
      ).filter(Boolean);
      if (pkg.source?.includes('github.com/maka-agent/cua')) {
        add(
          component,
          source,
          await readFile(join(root, 'platform/computer-use/THIRD_PARTY_NOTICES'), 'utf8'),
        );
      } else if (supplements[pkg.name + '@' + pkg.version]) {
        for (const entry of supplements[pkg.name + '@' + pkg.version]) {
          if (typeof entry === 'string') add(component, entry, await download(entry));
          else add(component, entry.source, await readFile(join(root, entry.file), 'utf8'));
        }
      } else if (!local.length || references) {
        for (const [url, content] of await upstreamFiles(pkg, directory, provenance))
          add(component, url, content);
      }
      for (const file of local)
        add(
          component,
          source + ' :: ' + relative(directory, file).replaceAll('\\', '/'),
          await readFile(file, 'utf8'),
        );
    } catch (error) {
      failures.push(
        new Error(pkg.name + '@' + pkg.version + ': ' + error.message, { cause: error }),
      );
    }
  }
  if (failures.length)
    throw new AggregateError(failures, failures.map((error) => error.message).join('\n'));
  const stage = await mkdtemp(join(tmpdir(), 'maka-notices-'));
  try {
    const product = join(stage, 'product');
    const compiler = await uiCompiler(root);
    run(process.execPath, ['products/maka/bundle/scripts/build.mjs', '--output', product], root, {
      ...process.env,
      MAKA_UI_BUNDLER: compiler,
    });
    const bundled = new Set();
    const inputs = [
      // Standalone validators contain Ajv-generated code without importing its
      // compiler at runtime. Preserve that code's notice as well as imports.
      fileURLToPath(import.meta.resolve('ajv/dist/standalone/index.js')),
      ...JSON.parse(await readFile(join(product, 'bundle-inputs.json'), 'utf8')),
    ];
    for (const input of inputs) {
      let path = dirname(resolve(root, input));
      if (!path.includes('node_modules')) continue;
      while (true) {
        const manifest = await readFile(join(path, 'package.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        if (manifest?.name && manifest.version) break;
        if (dirname(path) === path) throw new Error('Cannot identify bundled package: ' + input);
        path = dirname(path);
      }
      bundled.add(path);
    }
    for (const directory of [...bundled].sort()) {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const local = await licenseFiles(directory);
      if (!local.length) throw new Error('Missing bundled JavaScript license: ' + pkg.name);
      for (const url of supplements[pkg.name + '@' + pkg.version] ?? [])
        add(`${pkg.name}@${pkg.version} (${pkg.license})`, url, await download(url));
      for (const file of local)
        add(
          `${pkg.name}@${pkg.version} (${pkg.license})`,
          `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz :: ${relative(directory, file).replaceAll('\\', '/')}`,
          await readFile(file, 'utf8'),
        );
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const sections = [...groups.values()]
    .map((group) =>
      [
        [...group.components].sort().join('\n'),
        [...group.sources].sort().join('\n'),
        group.content,
      ].join('\n\n'),
    )
    .sort();
  const content =
    'Third-party notices for the Maka native distribution\n\n' +
    'Dependency sources and alternative license texts are preserved below. Source URLs identify the exact distributed versions.\n\n' +
    sections.join('\n' + '='.repeat(80) + '\n\n');
  await writeFile(join(root, documentPath), content);
  await writeFile(
    join(root, manifestPath),
    JSON.stringify({ inputs: await inputs(root), sha256: hash(content) }, null, 2) + '\n',
  );
  return { components: packages.size + 1, texts: groups.size, bytes: Buffer.byteLength(content) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || !['check', 'generate'].includes(process.argv[2]))
    throw new Error('Usage: notices.mjs <check|generate>');
  console.log(process.argv[2] === 'check' ? await verifyNotices() : await generateNotices());
}

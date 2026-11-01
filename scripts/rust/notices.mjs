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
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
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
const localPath = (directory, file) => relative(directory, file).replaceAll('\\', '/');

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: Infinity });
}

async function localLicenses(directory, declared) {
  const files = await licenseFiles(directory);
  if (declared && !files.includes(resolve(directory, declared)))
    files.push(resolve(directory, declared));
  return Promise.all(
    files.sort().map(async (file) => ({
      path: localPath(directory, file),
      content: await readFile(file, 'utf8'),
    })),
  );
}

async function supplementTexts(root, entries) {
  return Promise.all(
    entries.map(async (entry) =>
      typeof entry === 'string'
        ? { url: entry }
        : {
            file: entry.file,
            source: entry.source,
            content: await readFile(join(root, entry.file), 'utf8'),
          },
    ),
  );
}

async function upstreamIdentity(pkg, directory, provenance) {
  const git = provenance
    ? new URL(provenance.repository + '#' + provenance.revision)
    : pkg.source?.startsWith('git+')
      ? new URL(pkg.source.slice(4))
      : undefined;
  const vcs = git
    ? undefined
    : JSON.parse(await readFile(join(directory, '.cargo_vcs_info.json'), 'utf8'));
  const repository = /^https?:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?(?:[/?]|$)/.exec(
    git ? git.origin + git.pathname : (pkg.repository ?? ''),
  )?.[1];
  const revision = git ? git.hash.slice(1) : vcs.git?.sha1;
  if (!repository || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Missing pinned license source for ' + pkg.name);
  return { repository, revision };
}

/** Resolve installed components and licensing facts, independently of the reviewed snapshot. */
async function components(root, { bundleInputs, target, env = process.env }) {
  if (!bundleInputs) throw new Error('The current product bundle input manifest is required');
  const records = new Map();
  function add(record) {
    const digest = hash(
      JSON.stringify({
        component: record.component,
        license: record.license,
        files: record.files.map(({ path, content }) => [path, hash(content)]),
        texts: record.texts
          .map(({ url, file, source, content }) =>
            url ? { url } : { file, source, sha256: hash(content) },
          )
          .sort((a, b) => {
            const left = JSON.stringify(a);
            const right = JSON.stringify(b);
            return left < right ? -1 : left > right ? 1 : 0;
          }),
        upstream: record.upstream,
      }),
    );
    const previous = records.get(record.id);
    if (previous && previous.digest !== digest)
      throw new Error('Conflicting installed license data for ' + record.id);
    if (!previous) records.set(record.id, { ...record, digest });
  }
  const supplements = JSON.parse(
    await readFile(join(root, 'scripts/rust/notices-sources.json'), 'utf8'),
  );
  const directory = join(root, 'third-party/playwright');
  const playwright = JSON.parse(await readFile(join(directory, 'upstream.json'), 'utf8'));
  const playwrightFiles = [];
  for (const path of ['injected.js', 'LICENSE', 'NOTICE', 'ThirdPartyNotices.txt']) {
    const content = await readFile(join(directory, path));
    if (hash(content) !== playwright.files[path])
      throw new Error(`Vendored Playwright ${path} does not match upstream.json`);
    playwrightFiles.push({ path, content });
  }
  add({
    id: `asset:${playwright.registry_package}@${playwright.registry_version} ${playwright.archive.url}#${playwright.archive.sha256}`,
    component: `${playwright.registry_package}@${playwright.registry_version} (${playwright.license}; vendored injected script)`,
    license: playwright.license,
    files: playwrightFiles,
    texts: playwrightFiles
      .filter(({ path }) => path !== 'injected.js')
      .map(({ path, content }) => ({
        source: `${playwright.archive.url} (SHA-256 ${playwright.archive.sha256}) :: package/${path}`,
        content: content.toString('utf8'),
      })),
  });
  const packages = new Map();
  for (const triple of target
    ? [target]
    : Object.values(nativeCliTargets).map(({ os, cpu }) => rustTarget(os, cpu))) {
    const metadata = JSON.parse(
      run(
        'cargo',
        ['metadata', '--locked', '--format-version', '1', '--filter-platform', triple],
        root,
        env,
      ),
    );
    const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
    const catalog = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
    const pending = ['maka-cli', 'maka-desktop-shell', 'maka-python-runtime'].map((name) => {
      const pkg = metadata.packages.find((pkg) => pkg.name === name);
      if (!pkg) throw new Error('Missing distribution root: ' + name);
      return pkg.id;
    });
    const seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const pkg = catalog.get(id);
      if (pkg.source || localPath(root, pkg.manifest_path).startsWith('third-party/'))
        packages.set(id + '\0' + pkg.manifest_path, pkg);
      for (const dependency of nodes.get(id).deps)
        if (dependency.dep_kinds.some((kind) => kind.kind !== 'dev')) pending.push(dependency.pkg);
    }
  }
  for (const pkg of [...packages.values()].sort((a, b) =>
    (a.name + a.version).localeCompare(b.name + b.version),
  )) {
    const directory = dirname(pkg.manifest_path);
    let provenance;
    let source = pkg.source;
    if (!source) {
      const vendored = localPath(root, directory).split('/').slice(0, 2).join('/');
      provenance = JSON.parse(await readFile(join(root, vendored, 'upstream.json'), 'utf8'));
      source = `${provenance.repository}#${provenance.revision} (adapted; ${localPath(root, directory)})`;
    }
    const files = await localLicenses(directory, pkg.license_file);
    const local = files.filter(({ content }) => content.trim().length >= 80);
    const references = files.some(
      ({ content }) => content.trim().length < 80 && content.includes('../'),
    );
    let texts;
    let upstream;
    if (pkg.source?.includes('github.com/maka-agent/cua'))
      texts = [
        {
          file: 'platform/computer-use/THIRD_PARTY_NOTICES',
          source,
          content: await readFile(join(root, 'platform/computer-use/THIRD_PARTY_NOTICES'), 'utf8'),
        },
      ];
    else if (supplements[pkg.name + '@' + pkg.version])
      texts = await supplementTexts(root, supplements[pkg.name + '@' + pkg.version]);
    else {
      texts = [];
      if (!local.length || references)
        upstream = await upstreamIdentity(pkg, directory, provenance);
    }
    const archive =
      pkg.source === 'registry+https://github.com/rust-lang/crates.io-index'
        ? `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`
        : source;
    texts.push(...local.map(({ path, content }) => ({ source: archive + ' :: ' + path, content })));
    add({
      id: `cargo:${pkg.name}@${pkg.version} ${source}`,
      component:
        `${pkg.name}@${pkg.version} (${pkg.license ?? 'MIT; see upstream notice'})` +
        (pkg.authors.length ? `; authors declared by package: ${pkg.authors.join(', ')}` : ''),
      license: pkg.license,
      files,
      texts,
      upstream,
    });
  }
  const dependencyRoot = resolve(root, env.MAKA_JS_DEPS ?? '.');
  const require = createRequire(join(dependencyRoot, 'package.json'));
  const modules = await realpath(join(dependencyRoot, 'node_modules'));
  const lock = JSON.parse(await readFile(join(dependencyRoot, 'package-lock.json'), 'utf8'));
  const bundled = new Set();
  // Ajv standalone validators embed compiler-generated code without importing it.
  for (const input of [
    require.resolve('ajv/dist/standalone/index.js'),
    ...JSON.parse(await readFile(bundleInputs, 'utf8')),
  ]) {
    if (!input.includes('node_modules')) continue;
    let directory = dirname(resolve(root, input));
    while (true) {
      const pkg = await readFile(join(directory, 'package.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (pkg?.name && pkg.version) break;
      if (dirname(directory) === directory)
        throw new Error('Cannot identify bundled package: ' + input);
      directory = dirname(directory);
    }
    bundled.add(directory);
  }
  for (const directory of [...bundled].sort()) {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const key = 'node_modules/' + localPath(modules, await realpath(directory));
    const locked = lock.packages[key];
    if (!locked?.resolved || locked.version !== pkg.version)
      throw new Error('Bundled package does not match its installed lock entry: ' + directory);
    const files = await localLicenses(directory);
    if (!files.length) throw new Error('Missing bundled JavaScript license: ' + pkg.name);
    const source = locked.resolved;
    const texts = await supplementTexts(root, supplements[pkg.name + '@' + pkg.version] ?? []);
    texts.push(...files.map(({ path, content }) => ({ source: source + ' :: ' + path, content })));
    add({
      id: `npm:${pkg.name}@${pkg.version} ${source} ${locked.integrity ?? ''}`,
      component: `${pkg.name}@${pkg.version} (${pkg.license})`,
      license: pkg.license,
      files,
      texts,
    });
  }
  return new Map([...records].sort(([a], [b]) => a.localeCompare(b)));
}

/** Check coverage of this build's actual components; extra reviewed platform notices are allowed. */
export async function verifyNotices(root, options) {
  const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'));
  if (manifest.sha256 !== hash(await readFile(join(root, documentPath))))
    throw new Error('Third-party notice document changed; regenerate and review the notices');
  const actual = await components(root, options);
  for (const [id, record] of actual)
    if (manifest.components[id] !== record.digest)
      throw new Error('Third-party notices do not cover current component or license data: ' + id);
  return join(root, documentPath);
}

export async function generateNotices(root, options) {
  const records = await components(root, options);
  const groups = new Map();
  const download = licenseDownloader(root);
  const upstream = new Map();
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
  async function upstreamFiles({ repository, revision }) {
    const key = repository + '/' + revision;
    if (!upstream.has(key)) {
      const entries = JSON.parse(
        run('gh', ['api', `repos/${repository}/contents?ref=${revision}`], root),
      );
      const licenses = entries.filter((entry) => entry.type === 'file' && licenseName(entry.name));
      for (const entry of entries.filter(
        (entry) => entry.type === 'dir' && /^licen[cs]es?$/i.test(entry.name),
      ))
        licenses.push(
          ...JSON.parse(
            run('gh', ['api', `repos/${repository}/contents/${entry.path}?ref=${revision}`], root),
          ).filter((entry) => entry.type === 'file'),
        );
      if (!licenses.length) throw new Error('No upstream license files for ' + key);
      upstream.set(
        key,
        licenses.map(
          (entry) => `https://raw.githubusercontent.com/${repository}/${revision}/${entry.path}`,
        ),
      );
    }
    return upstream.get(key);
  }
  for (const record of records.values()) {
    if (record.upstream)
      for (const url of await upstreamFiles(record.upstream))
        add(record.component, url, await download(url));
    for (const text of record.texts) {
      const source = text.url ?? text.source;
      add(record.component, source, text.url ? await download(text.url) : text.content);
    }
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
    JSON.stringify(
      {
        components: Object.fromEntries([...records].map(([id, record]) => [id, record.digest])),
        sha256: hash(content),
      },
      null,
      2,
    ) + '\n',
  );
  return { components: records.size, texts: groups.size, bytes: Buffer.byteLength(content) };
}

async function withProduct(root, action) {
  const stage = await mkdtemp(join(tmpdir(), 'maka-notices-'));
  try {
    const product = join(stage, 'product');
    run(process.execPath, ['products/maka/bundle/scripts/build.mjs', '--output', product], root, {
      ...process.env,
      MAKA_UI_BUNDLER: await uiCompiler(root),
      MAKA_UI_BUNDLE_DIR: '',
    });
    return await action(root, { bundleInputs: join(product, 'bundle-inputs.json') });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || !['check', 'generate'].includes(process.argv[2]))
    throw new Error('Usage: notices.mjs <check|generate>');
  console.log(
    await withProduct(repository, process.argv[2] === 'check' ? verifyNotices : generateNotices),
  );
}

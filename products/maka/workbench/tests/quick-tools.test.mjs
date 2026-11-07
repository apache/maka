/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const built = await build({
  stdin: {
    contents: `
    export * from './plugins/application/quick-tools/shared/input-history.ts';
    export * from './plugins/application/quick-tools/shared/assistant-layout.ts';
    export * from './plugins/application/quick-tools/shared/i18n.ts';
    export * from './plugins/application/quick-tools/shared/search.ts';
    export * from './plugins/application/quick-tools/tools/links/template.ts';
  `,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const tools = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
);

test('history restores the unfinished draft after traversing recent input', () => {
  const entries = ['first', 'second'];
  const newest = tools.recallInput(entries, -1, '', 'unfinished', 1);
  assert.deepEqual(newest, { index: 0, draft: 'unfinished', text: 'second' });
  const oldest = tools.recallInput(entries, newest.index, newest.draft, newest.text, 1);
  assert.equal(oldest.text, 'first');
  const next = tools.recallInput(entries, oldest.index, oldest.draft, oldest.text, -1);
  assert.equal(
    tools.recallInput(entries, next.index, next.draft, next.text, -1).text,
    'unfinished',
  );
});
test('history completion stays a suffix and does not suggest for empty or multiline input', () => {
  assert.equal(tools.completeInput(['Search old', 'Search newest'], 'search'), 'Search newest');
  assert.equal(tools.completeInput(['anything'], ''), undefined);
  assert.equal(tools.completeInput(['a\nb more'], 'a\nb'), undefined);
  const list = Array.from({ length: 60 }, (_, i) => String(i));
  assert.equal(tools.rememberInput(list, '0').length, 50);
  assert.equal(tools.rememberInput(list, '0').at(-1), '0');
});
test('Quicklink parameters encode values without changing URL authority or literal paths', () => {
  assert.equal(
    tools.expandTemplate('https://example.com/{词}?q={query}', { 词: '中文/路径', query: 'a&b' }),
    'https://example.com/%E4%B8%AD%E6%96%87%2F%E8%B7%AF%E5%BE%84?q=a%26b',
  );
  assert.equal(tools.expandTemplate('/tmp/{query}', {}), '/tmp/{query}');
  assert.throws(() => tools.validateTemplate('https://{host}/search'));
  assert.throws(() => tools.validateTemplate('javascript:alert(1)'));
  assert.throws(() => tools.expandTemplate('https://example.com/?q={query}', {}));
});
test('Quicklinks accept bare websites, local files, app links and named Raycast arguments', () => {
  assert.equal(tools.expandTemplate('  github.com  ', {}), 'https://github.com');
  assert.equal(tools.expandTemplate('localhost:3000/docs', {}), 'https://localhost:3000/docs');
  assert.equal(
    tools.expandTemplate('slack://channel?team=T&id=C', {}),
    'slack://channel?team=T&id=C',
  );
  assert.equal(tools.expandTemplate('file:///tmp/my%20folder', {}), '/tmp/my folder');
  assert.equal(tools.expandTemplate('~/Documents/{query}', {}), '~/Documents/{query}');
  assert.equal(
    tools.expandTemplate('example.com/search?q={argument name="Search"}', { Search: 'a&b' }),
    'https://example.com/search?q=a%26b',
  );
  for (const input of [
    'just some words',
    'javascript://x',
    '{protocol}://host',
    'https://{host}/',
    'https:///x{host}',
  ])
    assert.throws(() => tools.validateTemplate(input), input);
});
test('authored copy follows locale and preserves supplied user text', () => {
  tools.setQuickLocale('en');
  assert.equal(tools.qt('正在加载…'), 'Loading…');
  assert.equal(tools.qt('请填写${0}', '我的名字'), 'Enter 我的名字');
  tools.setQuickLocale('zh-CN');
  assert.equal(tools.qt('正在加载…'), '正在加载…');
});

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const segment = (text) =>
  [...segmenter.segment(text)].filter((part) => part.isWordLike).map((part) => part.segment);
test('search preserves aliases, Chinese intent, fuzzy names and recent-only defaults', () => {
  const rows = [
    { id: 'notes', name: '笔记', kind: 'tool', keywords: '记录 memo notes' },
    { id: 'code', name: 'Visual Studio Code', kind: 'application' },
    { id: 'app', name: 'Unused app', kind: 'application' },
  ];
  const prefs = { code: { alias: '编辑', uses: 2 } };
  assert.deepEqual(
    tools.searchEntries(rows, '', prefs, segment).map((row) => row.id),
    ['code', 'notes'],
  );
  for (const query of ['编辑', 'vsc'])
    assert.equal(tools.searchEntries(rows, query, prefs, segment)[0].id, 'code');
  for (const query of ['记一下', 'memo'])
    assert.equal(tools.searchEntries(rows, query, prefs, segment)[0].id, 'notes');
  assert.deepEqual(tools.searchEntries(rows, 'no match', prefs, segment), []);
});

test('legacy import preserves originals and native edits and is idempotent', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { importLegacy } = await import('../../../../scripts/quick-tools/import-legacy.mjs');
  const dir = await fs.mkdtemp(join(tmpdir(), 'maka-quick-import-'));
  try {
    const source = join(dir, 'old'),
      target = join(dir, 'native');
    await fs.mkdir(join(source, 'plugins'), { recursive: true });
    await fs.mkdir(target);
    const config = {
      version: 2,
      enabled: true,
      shortcut: 'Alt+Space',
      disabled: ['maka.clipboard'],
      preferences: { 'maka.links/link:x': { alias: 'old', hotkey: 'Command+1' } },
    };
    await fs.writeFile(join(source, 'plugins/host.json'), JSON.stringify(config));
    await fs.writeFile(
      join(source, 'plugins/maka.links.json'),
      JSON.stringify([
        { id: 'x', name: 'old' },
        { id: 'y', name: 'retained' },
      ]),
    );
    await fs.writeFile(
      join(target, 'maka.links.json'),
      JSON.stringify([{ id: 'x', name: 'native' }]),
    );
    assert.equal((await importLegacy(source, target)).applied, false);
    assert.equal(JSON.parse(await fs.readFile(join(target, 'maka.links.json'))).length, 1);
    await importLegacy(source, target, { apply: true });
    assert.deepEqual(JSON.parse(await fs.readFile(join(target, 'maka.links.json'))), [
      { id: 'y', name: 'retained' },
      { id: 'x', name: 'native' },
    ]);
    assert.equal(
      JSON.parse(await fs.readFile(join(target, 'shortcuts.json')))['maka.links:link:x'],
      'Command+1',
    );
    assert.deepEqual(JSON.parse(await fs.readFile(join(source, 'plugins/host.json'))), config);
    assert.equal((await importLegacy(source, target, { apply: true })).files, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const runtimeBuild = await build({
  stdin: {
    contents: `export { Packages } from './plugins/application/quick-tools/runtime/packages';
      export { WebPlugins } from './plugins/application/quick-tools/runtime/web';`,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'native-host-fixture',
      setup(build) {
        build.onResolve({ filter: /^nsh$/ }, () => ({ path: 'nsh', namespace: 'fixture' }));
        build.onResolve({ filter: /^\.\/storage$/ }, () => ({
          path: 'storage',
          namespace: 'fixture',
        }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents:
            path === 'nsh'
              ? `export const host={call:async(name,{code})=>{if(name!=='quickTools.plugin.validate')throw Error(name);new Function(code);return true;}};`
              : `const data=new Map();export async function read(key,fallback){return structuredClone(data.get(key)??fallback);}export async function write(key,value){await new Promise(resolve=>setTimeout(resolve,1));data.set(key,structuredClone(value));}`,
        }));
      },
    },
  ],
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(runtimeBuild.outputFiles[0].text).toString('base64')}`
);

test('package updates reject stale previews, serialize independent installs, and retain rollback', async () => {
  const packages = new runtime.Packages();
  await packages.start();
  const bundle = (id, version) => ({
    format: 1,
    manifest: {
      apiVersion: 1,
      id,
      name: id,
      version,
      description: 'test',
      permissions: [],
      commands: [],
    },
    code: 'module.exports.default=()=>({});',
  });
  const first = await packages.preview(bundle('test.first', '1'));
  const second = await packages.preview(bundle('test.second', '1'));
  await Promise.all([packages.commit(first.token), packages.commit(second.token)]);
  assert.equal(packages.records.length, 2);
  const update = await packages.preview(bundle('test.first', '2'));
  const stale = await packages.preview(bundle('test.first', '3'));
  await packages.commit(update.token);
  await assert.rejects(packages.commit(stale.token));
  assert.equal((await packages.rollback('test.first')).manifest.version, '1');
  await packages.remove('test.first');
  assert.deepEqual(
    packages.records.map((record) => record.bundle.manifest.id),
    ['test.second'],
  );
  await assert.rejects(packages.preview(bundle('preferences', '1')));
});

test('web adapters cannot silently change their declared access or domain', async () => {
  let runs = 0;
  const web = new runtime.WebPlugins(async () => ({
    call: async (name) => {
      if (name === 'site_run') runs++;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              results: [
                { site: 'example', name: 'search', access: 'write', domain: 'example.com' },
              ],
            }),
          },
        ],
      };
    },
    close: async () => {},
  }));
  const manifest = {
    permissions: ['web.run'],
    id: 'test.web',
    web: {
      commands: [
        { id: 'search', site: 'example', command: 'search', domain: 'example.com', access: 'read' },
      ],
    },
  };
  await assert.rejects(
    web.run(manifest, { command: 'search', args: {} }, () => true),
    /access\/domain changed/,
  );
  assert.equal(runs, 0);
});

test('legacy external packages retain previous versions and reject tampering before writes', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { importLegacy } = await import('../../../../scripts/quick-tools/import-legacy.mjs');
  const directory = await fs.mkdtemp(join(tmpdir(), 'maka-quick-packages-'));
  try {
    const source = join(directory, 'old'),
      target = join(directory, 'native');
    await fs.mkdir(join(source, 'plugins'), { recursive: true });
    await fs.writeFile(
      join(source, 'plugins/host.json'),
      JSON.stringify({
        version: 2,
        enabled: true,
        shortcut: 'Alt+Space',
        disabled: [],
        preferences: {},
      }),
    );
    const artifact = async (version) => {
      const manifest = {
        apiVersion: 1,
        id: 'test.imported',
        name: 'Imported',
        version,
        description: '',
        permissions: [],
        commands: [],
      };
      const bundle = { format: 1, manifest, code: 'module.exports.default=()=>({});' };
      const digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
      const location = join(source, 'extensions/packages/test.imported', digest);
      await fs.mkdir(location, { recursive: true });
      await fs.writeFile(join(location, 'manifest.json'), JSON.stringify(manifest));
      await fs.writeFile(join(location, 'index.cjs'), bundle.code);
      return { manifest, digest };
    };
    const previous = await artifact('1'),
      current = await artifact('2');
    await fs.writeFile(
      join(source, 'extensions/registry.json'),
      JSON.stringify({ version: 1, records: [{ ...current, enabled: false, previous }] }),
    );
    await importLegacy(source, target, { apply: true });
    const imported = JSON.parse(await fs.readFile(join(target, 'extensions.json'), 'utf8'))
      .records[0];
    assert.equal(imported.bundle.manifest.version, '2');
    assert.equal(imported.previous.bundle.manifest.version, '1');
    assert.equal(
      JSON.parse(await fs.readFile(join(target, 'preferences.json'), 'utf8'))['test.imported']
        .enabled,
      false,
    );
    await fs.writeFile(
      join(source, 'extensions/packages/test.imported', current.digest, 'index.cjs'),
      'tampered',
    );
    await assert.rejects(
      importLegacy(source, join(directory, 'untouched'), { apply: true }),
      /integrity/,
    );
    await assert.rejects(fs.stat(join(directory, 'untouched')), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('quick assistant shows newest messages first with replies above prompts and no process rows', () => {
  assert.deepEqual(
    tools.quickAssistantOrder([
      { key: 'u1', kind: 'row', turn: 'a', role: 'user' },
      { key: 'internal', kind: 'row', turn: 'a', role: 'assistant' },
      { key: 'p1', kind: 'process', turn: 'a' },
      { key: 'b1', kind: 'bot', turn: 'a' },
      { key: 'u2', kind: 'row', turn: 'b', role: 'user' },
      { key: 'b2', kind: 'bot', turn: 'b' },
    ]),
    ['b2', 'u2', 'b1', 'u1'],
  );
  assert.deepEqual(
    tools.quickAssistantOrder([
      { key: 'old', kind: 'bot', turn: 'a' },
      { key: 'working', kind: 'botWorking' },
    ]),
    ['working', 'old'],
  );
});

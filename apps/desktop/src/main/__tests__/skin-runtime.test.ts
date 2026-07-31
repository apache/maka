import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import {
  createSkinRuntime,
  assertSelfContainedSkinModule,
  buildSkinActivationScript,
  inlineStylesheetAssets,
  normalizeArchiveFiles,
  parseSkinManifest,
  SkinRuntimeError,
  type SkinManifest,
  type SkinWebContents,
} from '../skin-runtime.js';

class FakeWebContents implements SkinWebContents {
  readonly listeners = new Map<string, Array<() => void>>();
  readonly insertedCss: string[] = [];
  readonly isolatedScripts: string[] = [];
  readonly removedCss: string[] = [];
  failurePattern: RegExp | null = null;

  insertCSS(css: string): Promise<string> {
    this.insertedCss.push(css);
    return Promise.resolve(`css-${this.insertedCss.length}`);
  }

  removeInsertedCSS(key: string): Promise<void> {
    this.removedCss.push(key);
    return Promise.resolve();
  }

  executeJavaScriptInIsolatedWorld(
    _worldId: number,
    scripts: Array<{ code: string }>,
  ): Promise<unknown> {
    this.isolatedScripts.push(...scripts.map((script) => script.code));
    if (this.failurePattern && scripts.some((script) => this.failurePattern?.test(script.code))) {
      return Promise.resolve({ ok: false, error: 'simulated activation failure' });
    }
    return Promise.resolve({ ok: true });
  }

  isDestroyed(): boolean {
    return false;
  }

  on(event: 'did-finish-load' | 'destroyed', listener: () => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
}

const validManifest: SkinManifest = {
  schemaVersion: 2,
  id: 'test.neon',
  name: 'Test Neon',
  version: '1.0.0',
  styles: 'theme.css',
  entry: 'entry.mjs',
  permissions: ['dom', 'canvas', 'storage'],
  minimumApiVersion: 2,
  requiredCapabilities: ['appearance.v1', 'parts.v1'],
};

test('parseSkinManifest validates the package contract', () => {
  const manifest = parseSkinManifest(validManifest);
  assert.equal(manifest.id, 'test.neon');
  assert.deepEqual(manifest.permissions, ['dom', 'canvas', 'storage']);
  assert.equal(manifest.minimumApiVersion, 2);
  assert.throws(
    () => parseSkinManifest({ ...validManifest, id: '../escape' }),
    (error: unknown) =>
      error instanceof SkinRuntimeError && error.code === 'invalid-manifest',
  );
  const legacy = parseSkinManifest({
    ...validManifest,
    schemaVersion: 1,
    minimumApiVersion: undefined,
    requiredCapabilities: undefined,
  });
  assert.equal(legacy.minimumApiVersion, 1);
  assert.deepEqual(legacy.requiredCapabilities, []);
});

test('normalizeArchiveFiles strips one wrapper and rejects traversal', () => {
  const wrapped = normalizeArchiveFiles({
    'skin/manifest.json': strToU8('{}'),
    'skin/theme.css': strToU8(':root{}'),
  });
  assert.deepEqual([...wrapped.keys()], ['manifest.json', 'theme.css']);
  assert.throws(
    () => normalizeArchiveFiles({
      'manifest.json': strToU8('{}'),
      '../outside.txt': strToU8('no'),
    }),
    /unsafe path/,
  );
});

test('inlineStylesheetAssets converts local asset URLs to data URLs', () => {
  assert.equal(
    inlineStylesheetAssets(
      '.hero { background: url("./assets/bg.png"); }',
      'theme.css',
      { 'assets/bg.png': 'data:image/png;base64,AAAA' },
    ),
    '.hero { background: url("data:image/png;base64,AAAA"); }',
  );
});

test('activation API exposes versioned capabilities, slots, semantic events, and controlled actions', () => {
  const script = buildSkinActivationScript(
    validManifest,
    'export function activate(api) { api.log(api.apiVersion); }',
    {},
  );
  for (const contract of [
    'appearance:',
    'capabilities:',
    'permissions:',
    'state:',
    'environment:',
    'tokens: tokenApi',
    'observe(name, handler)',
    'wait(name, timeoutMs = 5000)',
    'slots:',
    'mount(name, ownerId)',
    'all(name, ownerId)',
    'snapshot(type)',
    'actions:',
    'invoke(name, input = {})',
    'styles:',
    'lifecycle:',
  ]) {
    assert.match(script, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('module validation ignores import text in comments and strings but rejects real imports', () => {
  assert.doesNotThrow(() => assertSelfContainedSkinModule(`
    // import('comment-only')
    const example = "import('string-only')";
    export function activate() {}
  `));
  assert.throws(
    () => assertSelfContainedSkinModule('import value from "module"; export function activate() {}'),
    /cannot import/,
  );
  assert.throws(
    () => assertSelfContainedSkinModule('export async function activate() { await import("module"); }'),
    /cannot import/,
  );
});

test('runtime installs, activates, and disables a high-freedom skin', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-skin-test-'));
  try {
    const archivePath = join(temporaryRoot, 'neon.maka-skin');
    await writeFile(archivePath, zipSync({
      'manifest.json': strToU8(JSON.stringify({
        ...validManifest,
        permissions: [...validManifest.permissions, 'actions.stop', 'actions.composer'],
      })),
      'theme.css': strToU8('.hero { background: url("./assets/bg.svg"); }'),
      'entry.mjs': strToU8('export function activate(api) { api.log("ready"); return () => {}; }'),
      'assets/bg.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }));
    const runtime = createSkinRuntime({ rootDir: join(temporaryRoot, 'runtime') });
    const webContents = new FakeWebContents();
    runtime.attach(webContents);

    const inspection = await runtime.inspectFile(archivePath);
    assert.equal(inspection.manifest.id, 'test.neon');
    assert.match(inspection.archiveDigest, /^[a-f0-9]{64}$/);
    const installed = await runtime.installFromFile(archivePath, inspection.archiveDigest);
    assert.equal(installed.installed[0]?.manifest.id, 'test.neon');

    const active = await runtime.activate('test.neon');
    assert.equal(active.activeSkinId, 'test.neon');
    assert.match(webContents.insertedCss[0] ?? '', /data:image\/svg\+xml;base64/);
    assert.match(webContents.isolatedScripts.at(-1) ?? '', /Test Neon/);
    assert.equal(await runtime.authorizeAction('composer.submit'), false);
    assert.equal(await runtime.authorizeAction('generation.stop'), true);
    assert.equal(await runtime.authorizeAction('composer.focus'), true);

    const state = JSON.parse(
      await readFile(join(temporaryRoot, 'runtime', 'state.json'), 'utf8'),
    ) as { activationPending: boolean };
    assert.equal(state.activationPending, false);

    await writeFile(archivePath, zipSync({
      'manifest.json': strToU8(JSON.stringify(validManifest)),
      'theme.css': strToU8(':root { --changed-after-review: true; }'),
      'entry.mjs': strToU8('export function activate() {}'),
    }));
    await assert.rejects(
      runtime.installFromFile(archivePath, inspection.archiveDigest),
      /changed after its permissions were reviewed/,
    );

    const disabled = await runtime.disable();
    assert.equal(disabled.activeSkinId, null);
    assert.deepEqual(webContents.removedCss, ['css-1']);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('runtime recovers from an activation interrupted by a crash', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-skin-recovery-'));
  try {
    await writeFile(
      join(temporaryRoot, 'state.json'),
      JSON.stringify({
        activeSkinId: 'test.neon',
        activationPending: true,
        lastError: null,
      }),
    );
    const runtime = createSkinRuntime({ rootDir: temporaryRoot });
    const snapshot = await runtime.list();
    assert.equal(snapshot.activeSkinId, null);
    assert.equal(snapshot.recoveredFromFailedActivation, true);
    assert.match(snapshot.lastError ?? '', /disabled the previous skin/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('runtime updates, reloads, and uninstalls a skin without restarting', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-skin-update-test-'));
  try {
    const archivePath = join(temporaryRoot, 'neon.maka-skin');
    const writeArchive = (
      version: string,
      color: string,
      entry = 'export function activate() {}',
    ) =>
      writeFile(archivePath, zipSync({
        'manifest.json': strToU8(JSON.stringify({ ...validManifest, version, preview: 'preview.svg' })),
        'theme.css': strToU8(`:root { --accent: ${color}; }`),
        'entry.mjs': strToU8(entry),
        'preview.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      }));
    await writeArchive('1.0.0', 'red');

    const runtime = createSkinRuntime({ rootDir: join(temporaryRoot, 'runtime') });
    const webContents = new FakeWebContents();
    runtime.attach(webContents);
    await runtime.installFromFile(archivePath);
    await runtime.activate('test.neon');

    await writeArchive('1.1.0', 'blue');
    const updated = await runtime.installFromFile(archivePath);
    assert.equal(updated.installed[0]?.manifest.version, '1.1.0');
    assert.match(updated.installed[0]?.previewDataUrl ?? '', /^data:image\/svg\+xml;base64,/);
    assert.match(webContents.insertedCss.at(-1) ?? '', /blue/);

    await runtime.reload();
    assert.equal(webContents.insertedCss.length, 3);

    webContents.failurePattern = /BROKEN_SKIN/;
    await writeArchive('2.0.0', 'orange', 'export function activate() { /* BROKEN_SKIN */ }');
    await assert.rejects(
      runtime.installFromFile(archivePath),
      (error: unknown) =>
        error instanceof SkinRuntimeError && error.code === 'activation-failed',
    );
    const rolledBack = await runtime.list();
    assert.equal(rolledBack.installed[0]?.manifest.version, '1.1.0');
    assert.equal(rolledBack.activeSkinId, 'test.neon');

    const uninstalled = await runtime.uninstall('test.neon');
    assert.equal(uninstalled.activeSkinId, null);
    assert.deepEqual(uninstalled.installed, []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

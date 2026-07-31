import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import {
  createSkinRuntime,
  inlineStylesheetAssets,
  normalizeArchiveFiles,
  parseSkinManifest,
  SkinRuntimeError,
  type SkinWebContents,
} from '../skin-runtime.js';

class FakeWebContents implements SkinWebContents {
  readonly listeners = new Map<string, Array<() => void>>();
  readonly insertedCss: string[] = [];
  readonly isolatedScripts: string[] = [];
  readonly removedCss: string[] = [];

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

const validManifest = {
  schemaVersion: 1,
  id: 'test.neon',
  name: 'Test Neon',
  version: '1.0.0',
  styles: 'theme.css',
  entry: 'entry.mjs',
  permissions: ['dom', 'canvas', 'storage'],
};

test('parseSkinManifest validates the package contract', () => {
  const manifest = parseSkinManifest(validManifest);
  assert.equal(manifest.id, 'test.neon');
  assert.deepEqual(manifest.permissions, ['dom', 'canvas', 'storage']);
  assert.throws(
    () => parseSkinManifest({ ...validManifest, id: '../escape' }),
    (error: unknown) =>
      error instanceof SkinRuntimeError && error.code === 'invalid-manifest',
  );
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

test('runtime installs, activates, and disables a high-freedom skin', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-skin-test-'));
  try {
    const archivePath = join(temporaryRoot, 'neon.maka-skin');
    await writeFile(archivePath, zipSync({
      'manifest.json': strToU8(JSON.stringify(validManifest)),
      'theme.css': strToU8('.hero { background: url("./assets/bg.svg"); }'),
      'entry.mjs': strToU8('export function activate(api) { api.log("ready"); return () => {}; }'),
      'assets/bg.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }));
    const runtime = createSkinRuntime({ rootDir: join(temporaryRoot, 'runtime') });
    const webContents = new FakeWebContents();
    runtime.attach(webContents);

    const installed = await runtime.installFromFile(archivePath);
    assert.equal(installed.installed[0]?.manifest.id, 'test.neon');

    const active = await runtime.activate('test.neon');
    assert.equal(active.activeSkinId, 'test.neon');
    assert.match(webContents.insertedCss[0] ?? '', /data:image\/svg\+xml;base64/);
    assert.match(webContents.isolatedScripts.at(-1) ?? '', /Test Neon/);

    const state = JSON.parse(
      await readFile(join(temporaryRoot, 'runtime', 'state.json'), 'utf8'),
    ) as { activationPending: boolean };
    assert.equal(state.activationPending, false);

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

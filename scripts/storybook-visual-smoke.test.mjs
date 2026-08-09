import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { catalogJobs, startStaticServer, storyUrl } from './storybook-visual-smoke.mjs';

test('catalog jobs include every story once and reject an empty catalog', () => {
  assert.deepEqual(
    catalogJobs({
      entries: {
        docs: { id: 'docs', type: 'docs' },
        first: { id: 'product-first--default', type: 'story' },
        second: { id: 'product-second--default', type: 'story' },
      },
    }),
    [{ storyId: 'product-first--default' }, { storyId: 'product-second--default' }],
  );
  assert.throws(() => catalogJobs({ entries: {} }), /index has no stories/);
  assert.throws(() => catalogJobs(null), /index has no entries/);
});

test('render URLs disable play functions in embedded Storybook', () => {
  const url = new URL(storyUrl('http://127.0.0.1:6006', 'product-example--default'));
  assert.equal(url.pathname, '/iframe.html');
  assert.equal(url.searchParams.get('id'), 'product-example--default');
  assert.equal(url.searchParams.get('viewMode'), 'story');
  assert.equal(url.searchParams.get('embed'), 'true');
  assert.equal(url.searchParams.get('globals'), 'colorScheme:light');
});

test('the Storybook static server handles only the optional favicon specially', async () => {
  const staticDir = await mkdtemp(join(tmpdir(), 'maka-storybook-smoke-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>fixture</title>');
  const server = await startStaticServer(staticDir);

  try {
    const [indexResponse, missingFaviconResponse, missingAssetResponse] = await Promise.all([
      fetch(`${server.baseUrl}/`),
      fetch(`${server.baseUrl}/favicon.ico`),
      fetch(`${server.baseUrl}/missing-story-asset.js`),
    ]);

    assert.equal(indexResponse.status, 200);
    assert.equal(missingFaviconResponse.status, 204);
    assert.equal(await missingFaviconResponse.text(), '');
    assert.equal(missingAssetResponse.status, 404);

    await writeFile(join(staticDir, 'favicon.ico'), 'fixture-icon');
    const presentFaviconResponse = await fetch(`${server.baseUrl}/favicon.ico`);
    assert.equal(presentFaviconResponse.status, 200);
    assert.equal(await presentFaviconResponse.text(), 'fixture-icon');
  } finally {
    await server.close();
    await rm(staticDir, { recursive: true, force: true });
  }
});

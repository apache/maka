import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { configureInstalledEvalBundle } from '../eval-bundle-path.js';

describe('installed Eval bundle', () => {
  test('points Eval containers at the installed package root', async (t) => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'maka-cli-eval-bundle-'));
    t.after(() => rm(packageRoot, { recursive: true, force: true }));
    await mkdir(join(packageRoot, 'packages/eval'), { recursive: true });
    const environment: NodeJS.ProcessEnv = {};

    configureInstalledEvalBundle(environment, packageRoot);

    assert.equal(environment.MAKA_EVAL_MAKA_BUNDLE_PATH, packageRoot);
  });

  test('preserves an explicit bundle path', () => {
    const environment = { MAKA_EVAL_MAKA_BUNDLE_PATH: '/explicit/bundle' };

    configureInstalledEvalBundle(environment, '/installed/package');

    assert.equal(environment.MAKA_EVAL_MAKA_BUNDLE_PATH, '/explicit/bundle');
  });

  test('does not change source-checkout behavior without a packaged Eval mirror', () => {
    const environment: NodeJS.ProcessEnv = {};

    configureInstalledEvalBundle(environment, '/missing/package');

    assert.equal(Object.hasOwn(environment, 'MAKA_EVAL_MAKA_BUNDLE_PATH'), false);
  });
});

/**
 * PR-BUILD-HYGIENE-0 contract: the repo-root hygiene scripts and
 * `npm run clean` / `check:stale` entries must exist so future PRs
 * can't silently delete the foot-gun guard.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

describe('build-hygiene contract (PR-BUILD-HYGIENE-0)', () => {
  it('root package.json exposes clean / rebuild / check:stale scripts', () => {
    const raw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    assert.ok(scripts.clean, 'root package.json must define `clean`');
    assert.ok(scripts.rebuild, 'root package.json must define `rebuild`');
    assert.ok(scripts['check:stale'], 'root package.json must define `check:stale`');
    assert.ok(scripts['check:release'], 'root package.json must define `check:release`');
    assert.match(scripts.clean!, /clean-build\.mjs/);
    assert.match(scripts['check:stale']!, /check-stale-dist\.mjs/);
    assert.match(
      scripts['check:release']!,
      /check:stale/,
      '`check:release` must continue to gate on stale build output checks.',
    );
    assert.match(
      scripts['check:release']!,
      /check:third-party-notices/,
      '`check:release` must continue to gate on third-party notice integrity.',
    );
    assert.match(
      scripts['check:release']!,
      /check-dead-css\.mjs --check/,
      '`check:release` must continue to gate on the Round G dead-CSS baseline check.',
    );
  });

  it('build hygiene scripts exist under scripts/', () => {
    assert.ok(
      existsSync(join(REPO_ROOT, 'scripts', 'clean-build.mjs')),
      'scripts/clean-build.mjs must exist',
    );
    assert.ok(
      existsSync(join(REPO_ROOT, 'scripts', 'check-stale-dist.mjs')),
      'scripts/check-stale-dist.mjs must exist',
    );
    assert.ok(
      existsSync(join(REPO_ROOT, 'scripts', 'check-dead-css.mjs')),
      'scripts/check-dead-css.mjs must exist',
    );
    assert.ok(
      existsSync(join(REPO_ROOT, 'scripts', 'check-dead-css-baseline.json')),
      'scripts/check-dead-css-baseline.json must exist',
    );
  });
});

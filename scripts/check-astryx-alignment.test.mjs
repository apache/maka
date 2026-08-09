/**
 * Drives the real alignment gate script (not a reimplementation).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const script = join(root, 'scripts/check-astryx-alignment.mjs');

describe('check-astryx-alignment', () => {
  it('passes against the current product tree', () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /astryx alignment check: ok/);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PET_PACK_SCHEMA_V1,
  isPetPackManifestV1,
  isSafePetAssetPath,
  validatePetPackManifest,
} from '../pet.js';

function validManifest(): Record<string, unknown> {
  return {
    schema: PET_PACK_SCHEMA_V1,
    id: 'likun.maodie',
    displayName: '我的耄耋',
    description: 'A user-installed custom pet.',
    spriteSheet: {
      path: 'assets/maodie.webp',
      format: 'webp',
      frameWidth: 128,
      frameHeight: 128,
      columns: 4,
      rows: 4,
      frameCount: 16,
    },
    animations: {
      idle: { frames: [0, 1], fps: 4, loop: true },
      working: { frames: [2, 3, 4, 5], fps: 8, loop: true },
      'needs-input': { frames: [6, 7], fps: 4, loop: true },
      ready: { frames: [8, 9], fps: 8, loop: false, fallback: 'idle' },
      blocked: { frames: [10, 11], fps: 4, loop: true },
      swarm: { frames: [12, 13], fps: 12, loop: true },
      poke: { frames: [14, 15], fps: 10, loop: false, fallback: 'idle' },
    },
  };
}

describe('maka.pet/v1 manifest', () => {
  test('requires the five task-semantic animations', () => {
    const manifest = validManifest();
    const animations = manifest.animations as Record<string, unknown>;
    delete animations.blocked;

    const result = validatePetPackManifest(manifest);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.issues.find((issue) => issue.path === '$.animations.blocked'),
      {
        code: 'missing_animation',
        path: '$.animations.blocked',
        message: 'missing required blocked animation',
      },
    );
  });

  test('rejects executable or unknown manifest fields', () => {
    const manifest = validManifest();
    manifest.script = 'pet.js';
    (manifest.animations as Record<string, unknown>).onClick = { command: 'rm -rf .' };

    const result = validatePetPackManifest(manifest);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.issues.filter((issue) => issue.code === 'unknown_field').map((issue) => issue.path),
      ['$.script', '$.animations.onClick'],
    );
  });

  test('rejects traversal, absolute, Windows, and non-normalized asset paths', () => {
    for (const path of [
      '../maodie.webp',
      '/tmp/maodie.webp',
      'C:\\tmp\\maodie.webp',
      'assets\\maodie.webp',
      'assets//maodie.webp',
      './assets/maodie.webp',
    ]) {
      assert.equal(isSafePetAssetPath(path), false, path);
      const manifest = validManifest();
      (manifest.spriteSheet as Record<string, unknown>).path = path;
      const result = validatePetPackManifest(manifest);
      assert.equal(result.ok, false, path);
      if (!result.ok) assert.ok(result.issues.some((issue) => issue.code === 'unsafe_path'));
    }
  });

  test('bounds sprite geometry, animation rate, and referenced frames', () => {
    const manifest = validManifest();
    const spriteSheet = manifest.spriteSheet as Record<string, unknown>;
    spriteSheet.frameCount = 17;
    const idle = (manifest.animations as Record<string, Record<string, unknown>>).idle;
    idle.frames = [17];
    idle.fps = 61;

    const result = validatePetPackManifest(manifest);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.issues.some((issue) => issue.path === '$.spriteSheet.frameCount'));
    assert.ok(result.issues.some((issue) => issue.path === '$.animations.idle.frames[0]'));
    assert.ok(result.issues.some((issue) => issue.path === '$.animations.idle.fps'));
  });

  test('requires explicit animation fallback targets to exist', () => {
    const manifest = validManifest();
    const ready = (manifest.animations as Record<string, Record<string, unknown>>).ready;
    ready.fallback = 'sleep';

    const result = validatePetPackManifest(manifest);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(
      result.issues.some(
        (issue) =>
          issue.code === 'invalid_reference' && issue.path === '$.animations.ready.fallback',
      ),
    );
  });

  test('rejects a fallback on a looping animation', () => {
    const manifest = validManifest();
    const idle = (manifest.animations as Record<string, Record<string, unknown>>).idle;
    idle.fallback = 'working';

    assert.equal(isPetPackManifestV1(manifest), false);
  });
});

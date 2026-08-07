import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PetPackManifestV1 } from '@maka/core';
import {
  derivePetActivityState,
  loadSelectedPetCompanion,
  petFrameSourceRect,
  samplePetAnimation,
  shouldReducePetMotion,
  syncPetPlaybackState,
  type PetCompanionSource,
} from '../../renderer/custom-pet-companion-model.js';

function manifest(id = 'likun.maodie'): PetPackManifestV1 {
  return {
    schema: 'maka.pet/v1',
    id,
    displayName: '耄耋',
    spriteSheet: {
      path: 'sprites.png',
      format: 'png',
      frameWidth: 64,
      frameHeight: 48,
      columns: 3,
      rows: 2,
      frameCount: 6,
    },
    animations: {
      idle: { frames: [0, 2, 5], fps: 2, loop: true },
      working: { frames: [1], fps: 1, loop: true },
      'needs-input': { frames: [2], fps: 1, loop: true },
      ready: { frames: [3], fps: 1, loop: true },
      blocked: { frames: [4], fps: 1, loop: true },
    },
  };
}

function source(overrides: Partial<PetCompanionSource> = {}): PetCompanionSource {
  const pet = manifest();
  return {
    getSelection: async () => pet.id,
    list: async () => [pet],
    readSpriteSheet: async () => ({
      ok: true,
      mimeType: 'image/png',
      bytes: Uint8Array.of(1, 2, 3),
    }),
    ...overrides,
  };
}

describe('custom pet companion model', () => {
  it('projects authoritative runtime signals onto pet activity states', () => {
    const base = {
      hasActiveSession: true,
      hasActiveInteraction: false,
      turnActive: false,
      sessionStatus: 'active' as const,
    };

    assert.equal(derivePetActivityState(base), 'idle');
    assert.equal(derivePetActivityState({ ...base, turnActive: true }), 'working');
    assert.equal(derivePetActivityState({
      ...base,
      turnActive: true,
      hasActiveInteraction: true,
    }), 'needs-input');
    assert.equal(derivePetActivityState({
      ...base,
      sessionStatus: 'waiting_for_user',
    }), 'needs-input');
    assert.equal(derivePetActivityState({
      ...base,
      turnActive: true,
      sessionStatus: 'blocked',
    }), 'blocked');
    assert.equal(derivePetActivityState({
      ...base,
      hasActiveSession: false,
      turnActive: true,
    }), 'idle');
  });

  it('lets a completion pulse finish before ordinary idle takes over', () => {
    assert.equal(syncPetPlaybackState({
      currentState: 'working',
      activityState: 'working',
      completionArrived: true,
      contextChanged: false,
    }), 'ready');
    assert.equal(syncPetPlaybackState({
      currentState: 'ready',
      activityState: 'idle',
      completionArrived: false,
      contextChanged: false,
    }), 'ready');
    assert.equal(syncPetPlaybackState({
      currentState: 'ready',
      activityState: 'blocked',
      completionArrived: false,
      contextChanged: false,
    }), 'blocked');
    assert.equal(syncPetPlaybackState({
      currentState: 'ready',
      activityState: 'idle',
      completionArrived: false,
      contextChanged: true,
    }), 'idle');
  });

  it('does not read the library when custom pets are disabled', async () => {
    let listCalls = 0;
    const result = await loadSelectedPetCompanion(source({
      getSelection: async () => null,
      list: async () => {
        listCalls += 1;
        return [];
      },
    }));

    assert.deepEqual(result, { kind: 'none' });
    assert.equal(listCalls, 0);
  });

  it('loads the selected manifest and its local sprite bytes', async () => {
    const result = await loadSelectedPetCompanion(source());

    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') return;
    assert.equal(result.manifest.id, 'likun.maodie');
    assert.equal(result.mimeType, 'image/png');
    assert.deepEqual([...result.bytes], [1, 2, 3]);
  });

  it('fails closed for stale selections and unreadable assets', async () => {
    assert.deepEqual(await loadSelectedPetCompanion(source({ list: async () => [] })), {
      kind: 'none',
    });
    assert.deepEqual(await loadSelectedPetCompanion(source({
      readSpriteSheet: async () => ({ ok: false, reason: 'corrupt_pack' }),
    })), { kind: 'none' });
  });

  it('samples sparse looping frames from elapsed time', () => {
    const animation = manifest().animations.idle;

    assert.deepEqual(samplePetAnimation(animation, 0), {
      frame: 0, sequenceIndex: 0, complete: false,
    });
    assert.equal(samplePetAnimation(animation, 500).frame, 2);
    assert.equal(samplePetAnimation(animation, 1_000).frame, 5);
    assert.equal(samplePetAnimation(animation, 1_500).frame, 0);
  });

  it('holds the last frame and reports completion for one-shot animations', () => {
    const animation = { frames: [3, 4], fps: 4, loop: false } as const;

    assert.deepEqual(samplePetAnimation(animation, 500), {
      frame: 4, sequenceIndex: 1, complete: true,
    });
  });

  it('maps a frame index onto the declared sprite grid', () => {
    assert.deepEqual(petFrameSourceRect(5, manifest().spriteSheet), {
      x: 128,
      y: 48,
      width: 64,
      height: 48,
    });
  });

  it('freezes animation for either accessibility or deterministic fixtures', () => {
    assert.equal(shouldReducePetMotion({
      reducedMotionAttribute: false,
      e2eFixtureAttribute: false,
      systemPreference: false,
    }), false);
    assert.equal(shouldReducePetMotion({
      reducedMotionAttribute: false,
      e2eFixtureAttribute: true,
      systemPreference: false,
    }), true);
    assert.equal(shouldReducePetMotion({
      reducedMotionAttribute: true,
      e2eFixtureAttribute: false,
      systemPreference: false,
    }), true);
  });
});

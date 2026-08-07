import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PetPackManifestV1 } from '@maka/core';
import {
  reconcileCustomPetLibrary,
  removeCustomPet,
  upsertCustomPet,
} from '../../renderer/settings/custom-pet-library-model.js';

function manifest(id: string, displayName = id): PetPackManifestV1 {
  return {
    schema: 'maka.pet/v1',
    id,
    displayName,
    spriteSheet: {
      path: 'sprites.png',
      format: 'png',
      frameWidth: 32,
      frameHeight: 32,
      columns: 5,
      rows: 1,
      frameCount: 5,
    },
    animations: {
      idle: { frames: [0], fps: 1, loop: true },
      working: { frames: [1], fps: 1, loop: true },
      'needs-input': { frames: [2], fps: 1, loop: true },
      ready: { frames: [3], fps: 1, loop: true },
      blocked: { frames: [4], fps: 1, loop: true },
    },
  };
}

describe('custom pet library settings model', () => {
  it('fails closed when selection and installed packs are observed across a remove event', () => {
    const snapshot = reconcileCustomPetLibrary(
      [manifest('likun.other')],
      'likun.maodie',
    );

    assert.equal(snapshot.selectedPetId, null);
    assert.deepEqual(snapshot.pets.map((pet) => pet.id), ['likun.other']);
  });

  it('keeps one actionable row per id while preserving store order', () => {
    const first = manifest('likun.maodie', '耄耋');
    const duplicate = manifest('likun.maodie', 'duplicate');
    const other = manifest('likun.other');

    const snapshot = reconcileCustomPetLibrary([first, duplicate, other], first.id);

    assert.deepEqual(snapshot.pets, [first, other]);
    assert.equal(snapshot.selectedPetId, first.id);
  });

  it('reconciles import and removal without leaving a removed pack selected', () => {
    const maodie = manifest('likun.maodie', '耄耋');
    const imported = upsertCustomPet(
      { pets: [], selectedPetId: null },
      maodie,
    );
    const selected = { ...imported, selectedPetId: maodie.id };

    assert.deepEqual(imported.pets, [maodie]);
    assert.deepEqual(removeCustomPet(selected, maodie.id), {
      pets: [],
      selectedPetId: null,
    });
  });
});

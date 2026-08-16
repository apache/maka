import type { PetPackManifestV1 } from '@maka/core/pet';

export interface CustomPetLibrarySnapshot {
  readonly pets: readonly PetPackManifestV1[];
  readonly selectedPetId: string | null;
}

/**
 * Treat the installed pack list as the authority for selection. The settings
 * store already repairs stale selections, but this renderer can observe the
 * list and selection on opposite sides of a remove event. Failing closed here
 * avoids briefly presenting a missing pack as active.
 *
 * Duplicate ids are also collapsed defensively. A healthy store cannot emit
 * them, but one row per actionable id keeps the UI deterministic if a damaged
 * library is recovered in place.
 */
export function reconcileCustomPetLibrary(
  manifests: readonly PetPackManifestV1[],
  selectedPetId: string | null,
): CustomPetLibrarySnapshot {
  const byId = new Map<string, PetPackManifestV1>();
  for (const manifest of manifests) {
    if (!byId.has(manifest.id)) byId.set(manifest.id, manifest);
  }
  const pets = [...byId.values()];
  return {
    pets,
    selectedPetId: selectedPetId !== null && byId.has(selectedPetId)
      ? selectedPetId
      : null,
  };
}

export function upsertCustomPet(
  snapshot: CustomPetLibrarySnapshot,
  manifest: PetPackManifestV1,
): CustomPetLibrarySnapshot {
  const existingIndex = snapshot.pets.findIndex((pet) => pet.id === manifest.id);
  const pets = [...snapshot.pets];
  if (existingIndex === -1) pets.push(manifest);
  else pets[existingIndex] = manifest;
  return reconcileCustomPetLibrary(pets, snapshot.selectedPetId);
}

export function removeCustomPet(
  snapshot: CustomPetLibrarySnapshot,
  petId: string,
): CustomPetLibrarySnapshot {
  return reconcileCustomPetLibrary(
    snapshot.pets.filter((pet) => pet.id !== petId),
    snapshot.selectedPetId,
  );
}

/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

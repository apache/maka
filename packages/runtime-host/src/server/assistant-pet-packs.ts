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

import { createSettingsStore } from '@maka/storage/settings-store';
import { isDeepStrictEqual } from 'node:util';
import { decodePetPackManifest } from '@maka/core/pet';
import {
  createPetPackStore,
  PET_PACK_MANIFEST_MAX_BYTES,
  PetPackStoreError,
} from '@maka/storage/pet-pack-store';

/** Installs in the same Host store as the desktop directory importer. Creation and selection are separate explicit actions. */
export function createAssistantPetPacks(
  stateRoot: string,
  readImage: (
    sessionId: string,
    path: string,
    signal: AbortSignal,
  ) => Promise<{ bytes: Uint8Array }>,
) {
  const store = createPetPackStore(stateRoot);
  const settings = createSettingsStore(stateRoot);
  return {
    list: () => store.list(),
    async status() {
      const { personalization } = await settings.get();
      const id = personalization.selectedPetId;
      return {
        selectedPetId: id ?? null,
        configured: !!id && !!(await store.get(id)) && !!(await store.readSpriteSheet(id)),
        mode: personalization.petMode,
      };
    },
    async select(petId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!(await store.get(petId)) || !(await store.readSpriteSheet(petId)))
        throw Error('Pet pack is not installed or its sprite is missing.');
      signal.throwIfAborted();
      await settings.update({ personalization: { selectedPetId: petId, petMode: 'assistant' } });
      return {
        selectedPetId: petId,
        mode: 'assistant',
        notice:
          '已保存此 Host 的宠物选择，运行中的本机桌面会自动加载。远程 Host 不会改变本机宠物。',
      };
    },
    async create(
      sessionId: string,
      input: { manifest: unknown; spriteSheetPath: string },
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      if (
        Buffer.byteLength(JSON.stringify(input.manifest, null, 2) + '\n') >
        PET_PACK_MANIFEST_MAX_BYTES
      )
        throw Error('Pet manifest exceeds 64 KiB.');
      const manifest = decodePetPackManifest(input.manifest);
      // The reader must use the invoking Session's filesystem execution boundary.
      const image = await readImage(sessionId, input.spriteSheetPath, signal);
      signal.throwIfAborted();
      let reused = false;
      try {
        await store.install({ manifest, spriteSheet: image.bytes });
      } catch (error) {
        if (!(error instanceof PetPackStoreError) || error.code !== 'already_installed')
          throw error;
        const existing = await store.get(manifest.id);
        const sprite = await store.readSpriteSheet(manifest.id);
        if (
          !isDeepStrictEqual(existing, manifest) ||
          !sprite ||
          !Buffer.from(sprite.bytes).equals(Buffer.from(image.bytes))
        )
          throw Error(
            `Pet pack ${manifest.id} already exists with different content. Choose a new id; the installed pack was preserved.`,
          );
        reused = true;
      }
      return {
        installed: true,
        reused,
        id: manifest.id,
        displayName: manifest.displayName,
        animations: Object.keys(manifest.animations),
        selectionChanged: false,
        notice:
          '已安装到执行此调用的 Host 宠物库，未改变宠物选择或开关。使用 AssistantPetPack select petId 或桌面宠物设置选择；远程 Host 的包不会自动复制到本机。安装成功不代表桌面已显示。',
      };
    },
  };
}

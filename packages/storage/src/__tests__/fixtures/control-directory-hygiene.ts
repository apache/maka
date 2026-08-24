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

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRootControlNamespace, STORAGE_ROOT_MARKER_FILE } from '../../root-authority.js';

// A storage root's control directory lives under the real OS account home, not
// inside the temporary root a test creates, so removing the temporary directory
// leaves the control directory behind. `resolveRootControlNamespace` reads
// `userInfo().homedir` on purpose — the directory carries `owner.lock`, which
// decides who may write a State Root, and an environment variable must not be
// able to move that trust boundary. Tests therefore have to remove what they
// created, and these helpers are the one place that knows how.

/** Removes the control directory for a rootId. Safe to call when none exists. */
export async function removeControlDirectory(rootId: string): Promise<void> {
  if (rootId.length === 0) return;
  await rm(join(resolveRootControlNamespace(), rootId), { recursive: true, force: true });
}

/**
 * Removes the control directory belonging to a storage root path, reading the
 * rootId from the root's own marker file.
 *
 * Only usable while the root still exists. A test that removes or quarantines
 * its root before teardown has already destroyed the marker that names the
 * control directory, so such tests must record the rootId at resolution time
 * with `trackControlDirectory` instead.
 */
export async function removeControlDirectoryForRootPath(rootPath: string): Promise<void> {
  const marker = await readFile(join(rootPath, STORAGE_ROOT_MARKER_FILE), 'utf8').catch(
    () => undefined,
  );
  if (marker === undefined) return;
  let rootId: unknown;
  try {
    rootId = (JSON.parse(marker) as { rootId?: unknown }).rootId;
  } catch {
    return;
  }
  if (typeof rootId !== 'string') return;
  await removeControlDirectory(rootId);
}

const trackedRootIds = new Set<string>();

/**
 * Records a resolved root's control directory for teardown and returns the
 * capability unchanged, so it can wrap a `resolveStorageRoot` call in place.
 * The record survives the root itself, which is what teardown needs. Node's
 * test runner gives each file its own process, so the set is per-file state.
 */
export function trackControlDirectory<Capability extends { readonly rootId: string }>(
  capability: Capability,
): Capability {
  trackedRootIds.add(capability.rootId);
  return capability;
}

/** Removes every control directory recorded by `trackControlDirectory` so far. */
export async function removeTrackedControlDirectories(): Promise<void> {
  const rootIds = [...trackedRootIds];
  trackedRootIds.clear();
  await Promise.all(rootIds.map(removeControlDirectory));
}

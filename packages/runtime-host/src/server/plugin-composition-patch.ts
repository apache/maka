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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakaCompositionApplyInput } from '@maka/runtime/plugin-runtime';
import { parse } from 'yaml';
import { decodePluginCompositionApplyInput } from '../protocol/plugin-platform.js';
import type { InstalledPluginPackage } from './plugin-package-store.js';

const MAX_PATCH_BYTES = 512 * 1024;

export class PluginCompositionPatchError extends Error {
  readonly name = 'PluginCompositionPatchError';
}

/** Reads the declarative Composition layer shipped by one installed package. */
export async function loadPluginCompositionPatch(
  installed: InstalledPluginPackage,
): Promise<MakaCompositionApplyInput | undefined> {
  const relativePath = installed.manifest.composition?.patch;
  if (!relativePath) return undefined;
  let encoded: Buffer;
  try {
    encoded = await readFile(join(installed.root, ...relativePath.split('/')));
  } catch (error) {
    throw invalid(`Unable to read Plugin Composition patch: ${relativePath}`, error);
  }
  if (encoded.byteLength > MAX_PATCH_BYTES) {
    throw invalid(`Plugin Composition patch exceeds its size limit: ${relativePath}`);
  }
  let value: unknown;
  try {
    value = parse(encoded.toString('utf8'));
  } catch (error) {
    throw invalid(`Plugin Composition patch is invalid YAML: ${relativePath}`, error);
  }
  try {
    return decodePluginCompositionApplyInput({ operations: value });
  } catch (error) {
    throw invalid(`Plugin Composition patch is invalid: ${relativePath}`, error);
  }
}

function invalid(message: string, cause?: unknown): PluginCompositionPatchError {
  return new PluginCompositionPatchError(message, { cause });
}

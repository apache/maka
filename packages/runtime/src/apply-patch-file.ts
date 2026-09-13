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

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { applyDiff } from '@openai/agents-core/utils';

export class ApplyPatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyPatchRejectedError';
  }
}

export async function createPatchedFile(path: string, diff: string): Promise<void> {
  const content = patchContent('', diff, 'create');
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ApplyPatchRejectedError('ApplyPatch create target already exists.');
    }
    throw error;
  }
}

export async function updatePatchedFile(path: string, diff: string): Promise<void> {
  const content = await fs.readFile(path, 'utf8');
  const updated = patchContent(content, diff);
  if (updated !== content) await fs.writeFile(path, updated, 'utf8');
}

/**
 * The update transform for callers that pin the target with a file descriptor
 * (#2600): apply the diff to content already read through the handle; the
 * write happens through the caller's descriptor, not a second pathname lookup.
 */
export function applyUpdateToContent(content: string, diff: string): string {
  return patchContent(content, diff);
}

function patchContent(content: string, diff: string, mode?: 'create'): string {
  try {
    return applyDiff(content, diff, mode);
  } catch (error) {
    throw new ApplyPatchRejectedError(
      error instanceof Error ? error.message : 'ApplyPatch could not be applied.',
    );
  }
}

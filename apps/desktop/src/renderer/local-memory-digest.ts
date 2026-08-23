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

import type { Sha256Digest } from '@maka/core/local-memory';

/** Precompute one SubtleCrypto digest so the sync Sha256Digest seam can run in the renderer. */
export async function webSha256Digest(input: string): Promise<Sha256Digest> {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest !== 'function') {
    throw new Error('SubtleCrypto SHA-256 is not available');
  }
  const bytes = new Uint8Array(
    await subtle.digest('SHA-256', new TextEncoder().encode(input)),
  );
  return {
    digest(value: string): Uint8Array {
      if (value !== input) {
        throw new Error('webSha256Digest was asked to hash a different string');
      }
      return bytes;
    },
  };
}

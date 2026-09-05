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

// The installable CLI includes four reviewed direct-peer native addons so one
// immutable tarball works on every supported target without install scripts.
// These ceilings retain deliberate headroom while keeping later content spikes
// reviewable.
export const CLI_RELEASE_ARTIFACT_LIMITS = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  unpackedBytes: 128 * 1024 * 1024,
  entryCount: 9_000,
});

export function validateCliReleaseArtifactMetrics(metrics) {
  for (const key of ['compressedBytes', 'unpackedBytes', 'entryCount']) {
    const value = metrics[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`CLI release artifact ${key} must be a non-negative safe integer`);
    }
    const limit = CLI_RELEASE_ARTIFACT_LIMITS[key];
    if (value > limit) {
      throw new Error(`CLI release artifact ${key} is ${value}; limit is ${limit}`);
    }
  }
}

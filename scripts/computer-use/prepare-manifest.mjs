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

export const MAKA_CU_PROTOCOL_VERSION = 'maka.cu/3';
export const MAKA_CU_SOURCE_REPO = 'maka-agent/maka-cu';
export const MAKA_CU_SOURCE_URL = 'https://github.com/maka-agent/maka-cu.git';
export const MAKA_CU_SOURCE_BRANCH = 'maka/base';

export function buildMakaCuManifestEntry(input) {
  const distributionReady =
    input.signing.signature === 'developer-id' &&
    input.signing.hardenedRuntime === true &&
    input.stapled;
  return {
    repo: MAKA_CU_SOURCE_REPO,
    branch: MAKA_CU_SOURCE_BRANCH,
    commit: input.commit,
    tree: input.tree,
    expectedProtocolVersion: MAKA_CU_PROTOCOL_VERSION,
    binaryName: 'maka-cu',
    binarySizeBytes: input.binarySizeBytes,
    binarySha256: input.binarySha256,
    buildProvenance: 'isolated-official-source-build',
    ...input.signing,
    notarization: input.stapled ? 'stapled' : 'missing',
    distributionReady,
  };
}

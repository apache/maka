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

export function resolveMakaCuSourceBranch({ currentBranch, remoteBranches = [], explicitBranch }) {
  const explicit = explicitBranch?.trim();
  if (explicit) return explicit;

  const current = currentBranch.trim();
  if (current && current !== 'HEAD') return current;

  const candidates = [
    ...new Set(
      remoteBranches
        .map((branch) => branch.trim())
        .filter((branch) => branch.includes('/') && !branch.endsWith('/HEAD'))
        .map((branch) => branch.replace(/^[^/]+\//, '')),
    ),
  ];
  if (candidates.length === 1) return candidates[0];

  throw new Error(
    candidates.length === 0
      ? 'detached source commit has no matching remote branch'
      : `detached source commit matches multiple remote branches: ${candidates.join(', ')}`,
  );
}

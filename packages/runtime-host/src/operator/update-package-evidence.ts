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

interface ProductReleaseVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[];
}

export interface RuntimeHostNpmDeploymentIdentity {
  readonly kind: 'npm_registry';
  readonly version: string;
  readonly integrity: string;
}

/** Exact artifact evidence the Runtime Host can currently verify. */
export type RuntimeHostDeploymentIdentity = RuntimeHostNpmDeploymentIdentity;

export function isRuntimeHostNpmDeploymentIdentity(
  value: unknown,
): value is RuntimeHostNpmDeploymentIdentity {
  return (
    isRecord(value) &&
    value.kind === 'npm_registry' &&
    typeof value.version === 'string' &&
    isProductReleaseVersion(value.version) &&
    typeof value.integrity === 'string' &&
    isSha512PackageIntegrity(value.integrity)
  );
}

export function isProductReleaseVersion(value: string): boolean {
  return parseProductReleaseVersion(value) !== undefined;
}

export function compareProductReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseProductReleaseVersion(left);
  const b = parseProductReleaseVersion(right);
  if (!a || !b) throw new TypeError('Expected canonical Maka release versions');
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] < b.core[index]) return -1;
    if (a.core[index] > b.core[index]) return 1;
  }
  if (a.prerelease.length === 0) return b.prerelease.length === 0 ? 0 : 1;
  if (b.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function isSha512PackageIntegrity(value: string): boolean {
  if (!value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  if (encoded.length !== 88 || !/^[A-Za-z0-9+/]+={2}$/u.test(encoded)) return false;
  const digest = Buffer.from(encoded, 'base64');
  return digest.length === 64 && digest.toString('base64') === encoded;
}

function parseProductReleaseVersion(value: string): ProductReleaseVersion | undefined {
  if (value.length > 512) return undefined;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
      value,
    );
  if (!match) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part[0] === '0')) {
    return undefined;
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

/**
 * Derive HostCapabilities and deferred ToolAvailability groups from the shared
 * tool catalog ∩ host binding (#1099). Hosts still construct MakaTool
 * instances; this module only projects names and surface metadata.
 */

import {
  MAKA_CATALOG_SURFACES,
  catalogSurfaceById,
  catalogToolByName,
  unknownBoundToolNames,
  type ToolHostId,
} from '@maka/core/tool-catalog';
import type { HostCapabilities } from './skills-context.js';
import type { ToolGroup } from './tool-availability.js';
import type { MakaTool } from './tool-runtime.js';

export interface ProductToolSurfacePolicy {
  readonly economy: boolean;
  readonly disabledSurfaceIds?: Iterable<string>;
}

export interface NormalizedProductToolSurfacePolicy {
  readonly economy: boolean;
  readonly disabledSurfaceIds: readonly string[];
}

export interface ProductToolSurfaceIdentity {
  readonly policy: NormalizedProductToolSurfacePolicy;
  readonly productToolNames: readonly string[];
}

export interface EffectiveProductToolSurface {
  readonly tools: readonly MakaTool[];
  readonly toolNames: ReadonlySet<string>;
  readonly productToolNames: readonly string[];
  readonly hostCapabilities: HostCapabilities;
  readonly toolAvailability: {
    readonly economy: boolean;
    readonly groups: readonly ToolGroup[];
  };
  readonly boundSurfaceIds: readonly string[];
  readonly identity: ProductToolSurfaceIdentity;
}

interface ReadonlySetOperand<T> {
  readonly size: number;
  has(value: T): boolean;
  keys(): Iterator<T>;
}

interface ReadonlySetAlgebra<T> {
  union<U>(other: ReadonlySetOperand<U>): Set<T | U>;
  intersection<U>(other: ReadonlySetOperand<U>): Set<T & U>;
  difference<U>(other: ReadonlySetOperand<U>): Set<T>;
  symmetricDifference<U>(other: ReadonlySetOperand<U>): Set<T | U>;
  isSubsetOf(other: ReadonlySetOperand<unknown>): boolean;
  isSupersetOf(other: ReadonlySetOperand<unknown>): boolean;
  isDisjointFrom(other: ReadonlySetOperand<unknown>): boolean;
}

function readonlySetSnapshot<T>(values: Iterable<T>): ReadonlySet<T> {
  const snapshot = new Set(values);
  const algebra = snapshot as Set<T> & ReadonlySetAlgebra<T>;
  const view: ReadonlySet<T> = Object.freeze({
    get size() {
      return snapshot.size;
    },
    has: (value: T) => snapshot.has(value),
    entries: () => snapshot.entries(),
    keys: () => snapshot.keys(),
    values: () => snapshot.values(),
    forEach: (callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => {
      snapshot.forEach((value, value2) => callback.call(thisArg, value, value2, view));
    },
    union: <U>(other: ReadonlySetOperand<U>) => algebra.union(other),
    intersection: <U>(other: ReadonlySetOperand<U>) => algebra.intersection(other),
    difference: <U>(other: ReadonlySetOperand<U>) => algebra.difference(other),
    symmetricDifference: <U>(other: ReadonlySetOperand<U>) => algebra.symmetricDifference(other),
    isSubsetOf: (other: ReadonlySetOperand<unknown>) => algebra.isSubsetOf(other),
    isSupersetOf: (other: ReadonlySetOperand<unknown>) => algebra.isSupersetOf(other),
    isDisjointFrom: (other: ReadonlySetOperand<unknown>) => algebra.isDisjointFrom(other),
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
    [Symbol.toStringTag]: 'Set',
  });
  return view;
}

export function projectEffectiveProductToolSurface(input: {
  host: ToolHostId;
  tools: readonly MakaTool[];
  policy: ProductToolSurfacePolicy;
}): EffectiveProductToolSurface {
  const disabledSurfaceIds = [...new Set(input.policy.disabledSurfaceIds ?? [])].sort();
  const excludedToolNames = new Set<string>();
  for (const surfaceId of disabledSurfaceIds) {
    const surface = catalogSurfaceById(surfaceId);
    if (!surface) throw new Error(`Unknown product-tool surface "${surfaceId}"`);
    for (const name of surface.toolNames) excludedToolNames.add(name);
  }
  for (const surface of MAKA_CATALOG_SURFACES) {
    if (surface.hosts[input.host] === 'supported') continue;
    for (const name of surface.toolNames) excludedToolNames.add(name);
  }
  const tools = input.tools.filter((tool) => !excludedToolNames.has(tool.name));
  const boundToolNames = new Set(tools.map((tool) => tool.name));
  const toolNames = readonlySetSnapshot(boundToolNames);
  const productToolNames = [...boundToolNames].filter((name) => catalogToolByName(name)).sort();
  const groups = buildDeferredToolGroupsFromCatalog(input.host, boundToolNames).map((group) =>
    Object.freeze({
      ...group,
      toolNames: Object.freeze([...group.toolNames]),
    }),
  );
  const hostCapabilities = buildHostCapabilitiesFromBinding(boundToolNames);
  const policy = Object.freeze({
    economy: input.policy.economy,
    disabledSurfaceIds: Object.freeze(disabledSurfaceIds),
  });
  return Object.freeze({
    tools: Object.freeze(tools),
    toolNames,
    productToolNames: Object.freeze(productToolNames),
    hostCapabilities,
    toolAvailability: Object.freeze({
      economy: input.policy.economy,
      groups: Object.freeze(groups),
    }),
    boundSurfaceIds: Object.freeze(groups.map((group) => group.id)),
    identity: Object.freeze({
      policy,
      productToolNames: Object.freeze([...productToolNames]),
    }),
  });
}

/** Build skill-host capability surface from the tools this process actually bound. */
export function buildHostCapabilitiesFromBinding(
  boundToolNames: Iterable<string>,
): HostCapabilities {
  const toolNames = new Set<string>();
  const capabilities = new Set<string>();
  for (const name of boundToolNames) {
    toolNames.add(name);
    const tags = catalogToolByName(name)?.capabilityTags;
    if (!tags) continue;
    for (const tag of tags) capabilities.add(tag);
  }
  const readonlyToolNames = readonlySetSnapshot(toolNames);
  if (capabilities.size === 0) return Object.freeze({ toolNames: readonlyToolNames });
  return Object.freeze({
    toolNames: readonlyToolNames,
    capabilities: readonlySetSnapshot(capabilities),
  });
}

/**
 * Deferred `load_tools` groups for a host: catalog surfaces that are supported
 * on the host, deferred, and have at least one bound member. Unsupported
 * affinity never appears, even if a name were somehow bound.
 */
export function buildDeferredToolGroupsFromCatalog(
  host: ToolHostId,
  boundToolNames: Iterable<string>,
): ToolGroup[] {
  const bound = boundToolNames instanceof Set ? boundToolNames : new Set(boundToolNames);
  const groups: ToolGroup[] = [];
  for (const surface of MAKA_CATALOG_SURFACES) {
    if (surface.economy !== 'deferred') continue;
    if (surface.hosts[host] !== 'supported') continue;
    const toolNames = surface.toolNames.filter((name) => bound.has(name));
    if (toolNames.length === 0) continue;
    groups.push({
      id: surface.id,
      label: surface.label,
      description: surface.description,
      toolNames,
    });
  }
  return groups;
}

/**
 * Product-tool catalog cleanliness for host wiring (#1099 S2).
 *
 * MCP tools (`mcp__…`) are external and out of product-catalog scope. Harness /
 * experiment names may be excluded by the caller before invoking this helper.
 * Throws when any remaining bound name is missing from the catalog.
 */
export function assertProductBindingCatalogClean(
  hostLabel: string,
  boundToolNames: Iterable<string>,
): void {
  const productNames = [...boundToolNames].filter((name) => !name.startsWith('mcp__'));
  const unknown = unknownBoundToolNames(productNames);
  if (unknown.length === 0) return;
  throw new Error(
    `[tool-catalog] ${hostLabel}: bound product tools missing from catalog: ${unknown.join(', ')}`,
  );
}

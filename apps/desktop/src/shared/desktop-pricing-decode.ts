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

// Runtime guard for the Pricing Settings types declared in `desktop-pricing.d.ts`.
// It is imported only by the Main IPC layer (never the renderer), so it stays a
// plain `.ts` outside the renderer-root/legacy-AppShell closure the architecture
// ratchet tracks — the types themselves are declaration-only for that reason.

import {
  comparePricingModelKeys,
  validateCanonicalPricingConfig,
} from '@maka/core/usage-stats/pricing';
import type { EffectivePricingEntry } from '@maka/runtime-host/protocol';
import type { DesktopPricingSnapshot } from './desktop-pricing.js';

export class DesktopPricingSnapshotDecodeError extends Error {
  constructor(message: string) {
    super(`Invalid pricing snapshot: ${message}`);
    this.name = 'DesktopPricingSnapshotDecodeError';
  }
}

/**
 * Validate a renderer-supplied `base` snapshot at the Main IPC boundary. The
 * renderer must not synthesize `revision`/`hostEpoch`/`connectionId`; this only
 * proves the shape it round-trips is well formed. A well-formed but *foreign*
 * base (wrong Host epoch/connection) is still rejected downstream by the
 * adapter's stale guard, and a merely stale revision degrades to a
 * `revision_conflict` — both intended, not errors.
 */
export function decodeDesktopPricingSnapshot(value: unknown): DesktopPricingSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DesktopPricingSnapshotDecodeError('snapshot must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.hostEpoch !== 'string' || record.hostEpoch === '') {
    throw new DesktopPricingSnapshotDecodeError('hostEpoch must be a non-empty string');
  }
  if (typeof record.connectionId !== 'string' || record.connectionId === '') {
    throw new DesktopPricingSnapshotDecodeError('connectionId must be a non-empty string');
  }
  if (
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 0
  ) {
    throw new DesktopPricingSnapshotDecodeError('revision must be a non-negative integer');
  }
  if (!Array.isArray(record.entries)) {
    throw new DesktopPricingSnapshotDecodeError('entries must be an array');
  }
  const entries = record.entries.map(decodeEffectivePricingEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (
      comparePricingModelKeys(
        entries[index - 1]!.pricing.modelKey,
        entries[index]!.pricing.modelKey,
      ) !== -1
    ) {
      throw new DesktopPricingSnapshotDecodeError('entries must be in canonical key order');
    }
  }
  return {
    hostEpoch: record.hostEpoch,
    connectionId: record.connectionId,
    revision: record.revision,
    entries,
  };
}

function decodeEffectivePricingEntry(value: unknown): EffectivePricingEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DesktopPricingSnapshotDecodeError('entry must be an object');
  }
  const record = value as Record<string, unknown>;
  const pricing = validateCanonicalPricingConfig(record.pricing);
  if (!pricing.ok) {
    throw new DesktopPricingSnapshotDecodeError(`entry pricing is invalid (${pricing.error})`);
  }
  if (record.source === 'builtin') {
    return { pricing: pricing.value, source: 'builtin' };
  }
  if (record.source === 'custom') {
    if (
      record.resetEffect !== 'restore_builtin' &&
      record.resetEffect !== 'become_unpriced'
    ) {
      throw new DesktopPricingSnapshotDecodeError('custom entry has an invalid resetEffect');
    }
    return { pricing: pricing.value, source: 'custom', resetEffect: record.resetEffect };
  }
  throw new DesktopPricingSnapshotDecodeError('entry source must be "builtin" or "custom"');
}

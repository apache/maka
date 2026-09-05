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

import {
  normalizeRelayModelProfiles,
  type RelayModelProfile,
  type RelayModelProfiles,
} from '@maka/core/model-thinking';

/**
 * Reseed decision for the relay-profile editor's local draft. The editor is
 * one component instance that can serve a sequence of connections (the
 * settings page swaps the `connection` prop under it), and its draft state
 * is connection-scoped: a dirty draft belongs to the slug that made it.
 */
export interface RelayProfileDraftLifecycle {
  readonly slug: string;
  readonly dirty: boolean;
}

export interface RelayProfileDraftReseed {
  readonly reseed: boolean;
  readonly clearDirty: boolean;
}

/**
 * Slug switch always wins over unsaved edits: carrying draft A onto
 * connection B would show B one model's capabilities borrowed from A, and
 * the next 保存能力声明 would write A's declarations into B's document.
 * A same-slug reload only reseeds while the draft is clean, so an unrelated
 * refresh never discards typed work.
 */
export function relayProfileDraftReseedPlan(
  lifecycle: RelayProfileDraftLifecycle,
  connectionSlug: string,
): RelayProfileDraftReseed {
  if (lifecycle.slug !== connectionSlug) {
    return { reseed: true, clearDirty: true };
  }
  return { reseed: !lifecycle.dirty, clearDirty: false };
}

/**
 * The saved table in draft form. A hand-edited local connections file may
 * carry values that don't typecheck (`thinkingLevels: "low"`, string context
 * windows); runtime reads sanitize through `relayModelProfile`, so the
 * editor seeds from the same sanitizer — the draft shows exactly what would
 * persist if saved right away, and the "malformed is noise" promise holds
 * identically on both sides.
 */
export function relayProfileDraftSeed(
  profiles: RelayModelProfiles | undefined,
): Record<string, RelayModelProfile> {
  return normalizeRelayModelProfiles(profiles) ?? {};
}

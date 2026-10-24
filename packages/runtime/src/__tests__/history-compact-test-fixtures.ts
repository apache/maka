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

import assert from 'node:assert/strict';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildModelProjectionTransition,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import { compatibilityToolResultProjection } from '../durable-tool-result-projection.js';
import type { LoadedModelProjectionTransitions } from '../model-projection-transition-ledger.js';

export function sectionedSummary(goal: string): string {
  return `## Goal\n${goal}\n\n## Progress\n- done\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)`;
}

/** The empty transition view: folding through it is the identity. */
export const EMPTY_PROJECTION_SNAPSHOT: LoadedModelProjectionTransitions = {
  transitions: [],
  unreadableTargets: new Set<string>(),
  unscopedUnreadable: 0,
};

/**
 * A model-projection transition that replaces a `function_response` event's
 * tool-result projection with fixed text — the archive shape checkpoint
 * currency tests fold covered spans through.
 */
export function archiveTransitionFor(
  event: RuntimeEvent,
  replacementText: string,
): ModelProjectionTransition {
  const content = event.content as Extract<RuntimeEvent['content'], { kind: 'function_response' }>;
  const sourceProjection = compatibilityToolResultProjection(content, event.sessionId);
  assert.ok(sourceProjection);
  return buildModelProjectionTransition({
    sessionId: event.sessionId,
    target: {
      runtimeEventId: event.id,
      part: 'tool_result',
      toolCallId: content.id,
      toolName: content.name,
    },
    sourceProjection,
    replacement: { version: 1, kind: 'text', text: replacementText },
    now: 1,
  });
}

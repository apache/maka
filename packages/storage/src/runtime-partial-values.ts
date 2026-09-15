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

import { createHash } from 'node:crypto';
import type { RuntimeEvent } from '@maka/core/runtime-event';

export interface RuntimePartialSnapshot {
  event: RuntimeEvent;
  afterEventId?: string;
}

export function mergeRuntimePartialSnapshots(
  immutableEvents: readonly RuntimeEvent[],
  snapshots: readonly RuntimePartialSnapshot[],
): RuntimeEvent[] {
  const { leading, afterEvent } = groupRuntimePartialSnapshots(snapshots);
  const merged = leading.sort(compareRuntimePartialSnapshots).map(({ event }) => event);
  for (const event of immutableEvents) {
    merged.push(event);
    const anchored = afterEvent.get(event.id);
    if (!anchored) continue;
    merged.push(...anchored.sort(compareRuntimePartialSnapshots).map((snapshot) => snapshot.event));
    afterEvent.delete(event.id);
  }
  for (const orphaned of afterEvent.values()) {
    merged.push(...orphaned.sort(compareRuntimePartialSnapshots).map((snapshot) => snapshot.event));
  }
  return merged;
}

export function groupRuntimePartialSnapshots(snapshots: readonly RuntimePartialSnapshot[]): {
  leading: RuntimePartialSnapshot[];
  afterEvent: Map<string, RuntimePartialSnapshot[]>;
} {
  const leading: RuntimePartialSnapshot[] = [];
  const afterEvent = new Map<string, RuntimePartialSnapshot[]>();
  for (const snapshot of snapshots) {
    if (!snapshot.afterEventId) {
      leading.push(snapshot);
      continue;
    }
    const grouped = afterEvent.get(snapshot.afterEventId) ?? [];
    grouped.push(snapshot);
    afterEvent.set(snapshot.afterEventId, grouped);
  }
  return { leading, afterEvent };
}

export function compareRuntimePartialSnapshots(
  left: RuntimePartialSnapshot,
  right: RuntimePartialSnapshot,
): number {
  return left.event.ts - right.event.ts || left.event.id.localeCompare(right.event.id);
}

export function partialRuntimeStream(event: RuntimeEvent):
  | {
      key: string;
      snapshot: RuntimeEvent;
      text: string;
    }
  | undefined {
  if (!event.partial || event.status !== undefined || event.actions) return undefined;
  const content = event.content;
  let identity: string | undefined;
  let text = '';
  if (
    content?.kind === 'text' &&
    content.attachments === undefined &&
    event.refs?.providerEventId &&
    hasOnlyKeys(event.refs, ['providerEventId'])
  ) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
    text = content.text;
  } else if (
    content?.kind === 'thinking' &&
    content.signature === undefined &&
    event.refs?.providerEventId &&
    hasOnlyKeys(event.refs, ['providerEventId'])
  ) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
    text = content.text;
  } else if (!content && event.refs?.toolCallId && hasOnlyKeys(event.refs, ['toolCallId'])) {
    identity = `tool:call:${event.refs.toolCallId}`;
  }
  if (!identity) return undefined;
  const key = runtimePartialStreamKey(identity, event);
  const snapshot =
    content?.kind === 'text' || content?.kind === 'thinking'
      ? { ...event, content: { ...content, text: '' } }
      : event;
  return { key, snapshot, text };
}

export function completedPartialRuntimeStreamKey(event: RuntimeEvent): string | undefined {
  if (event.partial) return undefined;
  const content = event.content;
  let identity: string | undefined;
  if ((content?.kind === 'text' || content?.kind === 'thinking') && event.refs?.providerEventId) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
  } else if (content?.kind === 'function_response' && event.refs?.toolCallId) {
    identity = `tool:call:${event.refs.toolCallId}`;
  }
  return identity ? runtimePartialStreamKey(identity, event) : undefined;
}

export function runtimePartialStreamKey(identity: string, event: RuntimeEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        event.branch ?? null,
        event.role,
        event.author,
      ]),
    )
    .digest('hex');
}

export function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

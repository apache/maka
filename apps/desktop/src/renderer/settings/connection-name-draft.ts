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

/** What the name draft was last seeded from. */
export interface ConnectionNameDraftLifecycle {
  readonly slug: string;
  readonly savedName: string;
}

/**
 * Whether the name draft should be reseeded from the connection.
 *
 * A slug switch always wins over unsaved typing: carrying draft A onto
 * connection B would let one save rename the wrong connection. A same-slug
 * change reseeds only while the draft still matches what was saved, so a
 * rename landing from this page — or from another client watching the same
 * catalog — never discards a name the user is in the middle of typing.
 */
export function connectionNameDraftReseed(
  lifecycle: ConnectionNameDraftLifecycle,
  connection: { readonly slug: string; readonly name: string },
  draft: string,
): boolean {
  if (lifecycle.slug !== connection.slug) return true;
  if (connection.name === lifecycle.savedName) return false;
  return draft === lifecycle.savedName;
}

/**
 * Whether the draft is a rename worth offering to save.
 *
 * Trimmed on both sides so trailing whitespace is neither a change to save nor
 * a name that renders as if it had none. An empty draft is not a change: the
 * catalog requires a name, and clearing the field is a half-finished edit
 * rather than a request to have no name.
 */
export function connectionNameDraftChanged(draft: string, savedName: string): boolean {
  const trimmed = draft.trim();
  return trimmed.length > 0 && trimmed !== savedName;
}

/** The value a rename commits, which is never the untrimmed draft. */
export function connectionNameToSave(draft: string): string {
  return draft.trim();
}

/** Which settled value a save is committing. */
export type ConnectionDetailSaveField = 'key' | 'endpoint' | 'name';

/**
 * Whether a completed save should also refresh the live model catalog.
 *
 * A new credential or a new endpoint changes what the catalog would answer,
 * and an empty cache means the model row has nothing but the static fallback
 * list to offer. A rename changes neither: the catalog a user lands on is the
 * same one, so an empty cache is no more urgent after a rename than before,
 * and a fetch nobody asked for can surface an error about a connection the
 * user only renamed.
 */
export function shouldRefreshModelsAfterSave(input: {
  readonly field: ConnectionDetailSaveField;
  readonly wroteNewKey: boolean;
  readonly hasCachedModels: boolean;
}): boolean {
  if (input.field === 'name') return false;
  return input.wroteNewKey || input.field === 'endpoint' || !input.hasCachedModels;
}

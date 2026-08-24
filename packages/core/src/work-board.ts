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

import { defineObjectShape, hasExactShape } from './record-schema.js';

/**
 * Work Board — user-owned deferred work and task entry points.
 *
 * Phase 0 contract. A board item is a user-owned work intention, never an
 * execution claim. Runtime state is projected by other modules; this module
 * only defines the durable item shape, its lifecycle, and input validation.
 */

export const WORK_BOARD_ITEM_SCHEMA_VERSION = 1;
export const WORK_BOARD_TITLE_MAX_CHARS = 240;
export const WORK_BOARD_NOTES_MAX_CHARS = 4_000;
export const WORK_BOARD_EXCERPT_MAX_CHARS = 4_000;
export const WORK_BOARD_ID_MAX_CHARS = 64;
export const WORK_BOARD_SESSION_ID_MAX_CHARS = 160;
export const WORK_BOARD_MESSAGE_ID_MAX_CHARS = 256;
export const WORK_BOARD_PROJECT_ID_MAX_CHARS = 160;
export const WORK_BOARD_DEFAULT_PAGE_SIZE = 50;
export const WORK_BOARD_PAGE_SIZE_MAX = 100;
export const WORK_BOARD_CURSOR_MAX_CHARS = 1024;

export const WORK_BOARD_ITEM_STATES = ['todo', 'in_progress', 'done'] as const;
export type WorkBoardItemState = (typeof WORK_BOARD_ITEM_STATES)[number];

export type WorkBoardScope = { kind: 'inbox' } | { kind: 'project'; projectId: string };

export type WorkBoardCreator = { kind: 'user' } | { kind: 'agent_suggestion'; confirmedAt: number };

export type WorkBoardProvenance =
  | { kind: 'manual' }
  | {
      kind: 'main_conversation';
      sessionId: string;
      messageId: string;
      runId?: string;
      turnId?: string;
      capturedAt: number;
      excerpt: string;
    }
  | {
      kind: 'side_conversation';
      sessionId: string;
      parentSessionId: string;
      messageId: string;
      runId?: string;
      turnId?: string;
      capturedAt: number;
      excerpt: string;
    };

export interface WorkBoardItemBase {
  schemaVersion: typeof WORK_BOARD_ITEM_SCHEMA_VERSION;
  id: string;
  /** Monotonic per-item revision; incremented by every effective mutation. */
  revision: number;
  scope: WorkBoardScope;
  title: string;
  notes?: string;
  state: WorkBoardItemState;
  creator: WorkBoardCreator;
  provenance: WorkBoardProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface WorkBoardActiveItem extends WorkBoardItemBase {
  archived: false;
  archivedAt?: never;
}

export interface WorkBoardArchivedItem extends WorkBoardItemBase {
  archived: true;
  archivedAt: number;
}

export type WorkBoardItem = WorkBoardActiveItem | WorkBoardArchivedItem;

export interface CreateWorkBoardItemInput {
  scope: WorkBoardScope;
  title: string;
  notes?: string;
  creator: WorkBoardCreator;
  provenance: WorkBoardProvenance;
}

/**
 * Semantic patch. In this patch contract, an absent field — and therefore
 * `undefined` — means "not provided" and leaves the stored value untouched;
 * `notes: null`, an empty string, or a whitespace-only string is the explicit
 * "clear notes" signal. Never replace a whole stored item from the client.
 */
export interface UpdateWorkBoardItemInput {
  title?: string;
  notes?: string | null;
  scope?: WorkBoardScope;
  state?: WorkBoardItemState;
}

export interface WorkBoardListQuery {
  scope?: WorkBoardScope;
  includeArchived?: boolean;
  limit?: number;
  /** Opaque continuation returned by a previous page. */
  cursor?: string;
}

export interface WorkBoardPage {
  items: WorkBoardItem[];
  nextCursor?: string;
}

interface WorkBoardItemJsonShape {
  schemaVersion: number;
  id: string;
  revision: number;
  scope: WorkBoardScope;
  title: string;
  notes?: string;
  state: WorkBoardItemState;
  creator: WorkBoardCreator;
  provenance: WorkBoardProvenance;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  archivedAt?: number;
}

const WORK_BOARD_SCOPE_INBOX_SHAPE = defineObjectShape<{ kind: 'inbox' }>()(['kind'], []);
const WORK_BOARD_SCOPE_PROJECT_SHAPE = defineObjectShape<{ kind: 'project'; projectId: string }>()(
  ['kind', 'projectId'],
  [],
);
const WORK_BOARD_CREATOR_USER_SHAPE = defineObjectShape<{ kind: 'user' }>()(['kind'], []);
const WORK_BOARD_CREATOR_AGENT_SHAPE = defineObjectShape<{
  kind: 'agent_suggestion';
  confirmedAt: number;
}>()(['kind', 'confirmedAt'], []);
const WORK_BOARD_PROVENANCE_MANUAL_SHAPE = defineObjectShape<{ kind: 'manual' }>()(['kind'], []);
const WORK_BOARD_PROVENANCE_MAIN_SHAPE = defineObjectShape<
  Extract<WorkBoardProvenance, { kind: 'main_conversation' }>
>()(['kind', 'sessionId', 'messageId', 'capturedAt', 'excerpt'], ['runId', 'turnId']);
const WORK_BOARD_PROVENANCE_SIDE_SHAPE = defineObjectShape<
  Extract<WorkBoardProvenance, { kind: 'side_conversation' }>
>()(
  ['kind', 'sessionId', 'parentSessionId', 'messageId', 'capturedAt', 'excerpt'],
  ['runId', 'turnId'],
);
const WORK_BOARD_ITEM_SHAPE = defineObjectShape<WorkBoardItemJsonShape>()(
  [
    'schemaVersion',
    'id',
    'revision',
    'scope',
    'title',
    'state',
    'creator',
    'provenance',
    'createdAt',
    'updatedAt',
    'archived',
  ],
  ['notes', 'archivedAt'],
);
const WORK_BOARD_CREATE_INPUT_SHAPE = defineObjectShape<CreateWorkBoardItemInput>()(
  ['scope', 'title', 'creator', 'provenance'],
  ['notes'],
);
const WORK_BOARD_UPDATE_INPUT_SHAPE = defineObjectShape<UpdateWorkBoardItemInput>()(
  [],
  ['title', 'notes', 'scope', 'state'],
);
const WORK_BOARD_LIST_QUERY_SHAPE = defineObjectShape<WorkBoardListQuery>()(
  [],
  ['scope', 'includeArchived', 'limit', 'cursor'],
);

export type WorkBoardNormalizeResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function isWorkBoardItemState(value: unknown): value is WorkBoardItemState {
  return typeof value === 'string' && (WORK_BOARD_ITEM_STATES as readonly string[]).includes(value);
}

export function isSafeWorkBoardId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= WORK_BOARD_ID_MAX_CHARS &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

export function normalizeWorkBoardScope(input: unknown): WorkBoardNormalizeResult<WorkBoardScope> {
  if (!isRecord(input)) return fail('Work Board scope must be an object');
  if (input.kind === 'inbox') {
    if (!hasExactShape(input, WORK_BOARD_SCOPE_INBOX_SHAPE)) {
      return fail('Inbox scope must not carry extra fields');
    }
    return { ok: true, value: { kind: 'inbox' } };
  }
  if (input.kind !== 'project' || !hasExactShape(input, WORK_BOARD_SCOPE_PROJECT_SHAPE)) {
    return fail('Work Board scope must be inbox or a project');
  }
  const projectId = normalizeIdString(input.projectId, {
    field: 'scope.projectId',
    max: WORK_BOARD_PROJECT_ID_MAX_CHARS,
  });
  if (!projectId.ok) return projectId;
  return { ok: true, value: { kind: 'project', projectId: projectId.value } };
}

export function normalizeWorkBoardCreator(
  input: unknown,
): WorkBoardNormalizeResult<WorkBoardCreator> {
  if (!isRecord(input) || (input.kind !== 'user' && input.kind !== 'agent_suggestion')) {
    return fail('Work Board creator must be user or agent_suggestion');
  }
  if (input.kind === 'user') {
    if (!hasExactShape(input, WORK_BOARD_CREATOR_USER_SHAPE)) {
      return fail('User creator must not carry extra fields');
    }
    return { ok: true, value: { kind: 'user' } };
  }
  if (!hasExactShape(input, WORK_BOARD_CREATOR_AGENT_SHAPE)) {
    return fail('agent_suggestion creator shape is invalid');
  }
  const confirmedAt = asSafeInteger(input.confirmedAt);
  if (confirmedAt === null) {
    return fail('agent_suggestion creator requires a confirmedAt timestamp');
  }
  return { ok: true, value: { kind: 'agent_suggestion', confirmedAt } };
}

export function normalizeWorkBoardProvenance(
  input: unknown,
): WorkBoardNormalizeResult<WorkBoardProvenance> {
  if (!isRecord(input)) return fail('Work Board provenance must be an object');
  if (input.kind === 'manual') {
    if (!hasExactShape(input, WORK_BOARD_PROVENANCE_MANUAL_SHAPE)) {
      return fail('Manual provenance must not carry extra fields');
    }
    return { ok: true, value: { kind: 'manual' } };
  }
  const isMain = input.kind === 'main_conversation';
  const isSide = input.kind === 'side_conversation';
  if (!isMain && !isSide) return fail('Work Board provenance kind is invalid');
  const shape = isMain ? WORK_BOARD_PROVENANCE_MAIN_SHAPE : WORK_BOARD_PROVENANCE_SIDE_SHAPE;
  if (!hasExactShape(input, shape)) {
    return fail(`${input.kind} provenance shape is invalid`);
  }
  const sessionId = normalizeIdString(input.sessionId, {
    field: 'provenance.sessionId',
    max: WORK_BOARD_SESSION_ID_MAX_CHARS,
  });
  if (!sessionId.ok) return sessionId;
  const messageId = normalizeIdString(input.messageId, {
    field: 'provenance.messageId',
    max: WORK_BOARD_MESSAGE_ID_MAX_CHARS,
  });
  if (!messageId.ok) return messageId;
  const capturedAt = asSafeInteger(input.capturedAt);
  if (capturedAt === null) {
    return fail('provenance.capturedAt must be a non-negative integer');
  }
  const excerpt = normalizeOptionalText(input.excerpt, {
    field: 'provenance.excerpt',
    max: WORK_BOARD_EXCERPT_MAX_CHARS,
    required: true,
  });
  if (!excerpt.ok) return excerpt;
  if (excerpt.value === undefined) return fail('provenance.excerpt is required');
  const excerptValue = excerpt.value;
  const runId = normalizeOptionalToken(input.runId, 'provenance.runId');
  if (!runId.ok) return runId;
  const turnId = normalizeOptionalToken(input.turnId, 'provenance.turnId');
  if (!turnId.ok) return turnId;

  if (isMain) {
    return {
      ok: true,
      value: {
        kind: 'main_conversation',
        sessionId: sessionId.value,
        messageId: messageId.value,
        capturedAt,
        excerpt: excerptValue,
        ...(runId.value ? { runId: runId.value } : {}),
        ...(turnId.value ? { turnId: turnId.value } : {}),
      },
    };
  }

  const parentSessionId = normalizeIdString(input.parentSessionId, {
    field: 'provenance.parentSessionId',
    max: WORK_BOARD_SESSION_ID_MAX_CHARS,
  });
  if (!parentSessionId.ok) return parentSessionId;
  return {
    ok: true,
    value: {
      kind: 'side_conversation',
      sessionId: sessionId.value,
      parentSessionId: parentSessionId.value,
      messageId: messageId.value,
      capturedAt,
      excerpt: excerptValue,
      ...(runId.value ? { runId: runId.value } : {}),
      ...(turnId.value ? { turnId: turnId.value } : {}),
    },
  };
}

export function normalizeCreateWorkBoardItemInput(
  input: unknown,
): WorkBoardNormalizeResult<CreateWorkBoardItemInput> {
  if (!isRecord(input)) return fail('Work Board item input must be an object');
  if (!hasExactShape(input, WORK_BOARD_CREATE_INPUT_SHAPE)) {
    return fail('Work Board create input contains unknown fields');
  }
  const scope = normalizeWorkBoardScope(input.scope);
  if (!scope.ok) return scope;
  const title = normalizeOptionalText(input.title, {
    field: 'title',
    max: WORK_BOARD_TITLE_MAX_CHARS,
    required: true,
  });
  if (!title.ok) return title;
  if (title.value === undefined) return fail('title is required');
  const titleValue = title.value;
  if (input.notes === null) {
    return fail('notes must not be null in create input');
  }
  const notes = normalizeOptionalText(input.notes, {
    field: 'notes',
    max: WORK_BOARD_NOTES_MAX_CHARS,
    required: false,
  });
  if (!notes.ok) return notes;
  const creator = normalizeWorkBoardCreator(input.creator);
  if (!creator.ok) return creator;
  const provenance = normalizeWorkBoardProvenance(input.provenance);
  if (!provenance.ok) return provenance;
  return {
    ok: true,
    value: {
      scope: scope.value,
      title: titleValue,
      ...(notes.value === undefined ? {} : { notes: notes.value }),
      creator: creator.value,
      provenance: provenance.value,
    },
  };
}

export function normalizeUpdateWorkBoardItemInput(
  input: unknown,
): WorkBoardNormalizeResult<UpdateWorkBoardItemInput> {
  if (!isRecord(input)) return fail('Work Board update must be an object');
  if (!hasExactShape(input, WORK_BOARD_UPDATE_INPUT_SHAPE)) {
    return fail('Work Board update patch contains unknown fields');
  }
  const patch: UpdateWorkBoardItemInput = {};
  if (input.title !== undefined) {
    const title = normalizeOptionalText(input.title, {
      field: 'title',
      max: WORK_BOARD_TITLE_MAX_CHARS,
      required: true,
    });
    if (!title.ok) return title;
    patch.title = title.value;
  }
  // Contract: undefined means "not provided" (keep current value); only null
  // (or an empty/whitespace-only string) is an explicit clear. This is a
  // patch-API decision, not JavaScript's own `{ notes: undefined }` object
  // semantics.
  if (input.notes !== undefined) {
    if (input.notes === null || (typeof input.notes === 'string' && input.notes.trim() === '')) {
      patch.notes = null;
    } else {
      const notes = normalizeOptionalText(input.notes, {
        field: 'notes',
        max: WORK_BOARD_NOTES_MAX_CHARS,
        required: false,
      });
      if (!notes.ok) return notes;
      patch.notes = notes.value;
    }
  }
  if (input.scope !== undefined) {
    const scope = normalizeWorkBoardScope(input.scope);
    if (!scope.ok) return scope;
    patch.scope = scope.value;
  }
  if (input.state !== undefined) {
    if (!isWorkBoardItemState(input.state)) {
      return fail('Work Board state is invalid');
    }
    patch.state = input.state;
  }
  return { ok: true, value: patch };
}

export function normalizeWorkBoardListQuery(
  input: unknown,
): WorkBoardNormalizeResult<WorkBoardListQuery> {
  if (input === undefined) return { ok: true, value: {} };
  if (!isRecord(input)) return fail('Work Board list query must be an object');
  if (!hasExactShape(input, WORK_BOARD_LIST_QUERY_SHAPE)) {
    return fail('Work Board list query contains unknown fields');
  }
  const query: WorkBoardListQuery = {};
  if (input.scope !== undefined) {
    const scope = normalizeWorkBoardScope(input.scope);
    if (!scope.ok) return scope;
    query.scope = scope.value;
  }
  if (input.includeArchived !== undefined) {
    if (typeof input.includeArchived !== 'boolean') {
      return fail('includeArchived must be a boolean');
    }
    query.includeArchived = input.includeArchived;
  }
  if (input.limit !== undefined) {
    const limit = asSafeInteger(input.limit);
    if (limit === null || limit <= 0 || limit > WORK_BOARD_PAGE_SIZE_MAX) {
      return fail(`limit must be between 1 and ${WORK_BOARD_PAGE_SIZE_MAX}`);
    }
    query.limit = limit;
  }
  if (input.cursor !== undefined) {
    if (
      typeof input.cursor !== 'string' ||
      input.cursor.length === 0 ||
      input.cursor.length > WORK_BOARD_CURSOR_MAX_CHARS
    ) {
      return fail('cursor is invalid');
    }
    query.cursor = input.cursor;
  }
  return { ok: true, value: query };
}

export function decodeWorkBoardItem(value: unknown): WorkBoardItem | null {
  if (!isRecord(value)) return null;
  if (!hasExactShape(value, WORK_BOARD_ITEM_SHAPE)) return null;
  if (value.schemaVersion !== WORK_BOARD_ITEM_SCHEMA_VERSION) return null;
  const id = value.id;
  if (!isSafeWorkBoardId(id)) return null;
  const revision = asSafeInteger(value.revision);
  if (revision === null || revision < 1) return null;
  const state = value.state;
  if (!isWorkBoardItemState(state)) return null;
  const scope = normalizeWorkBoardScope(value.scope);
  if (!scope.ok) return null;
  const title = normalizeOptionalText(value.title, {
    field: 'title',
    max: WORK_BOARD_TITLE_MAX_CHARS,
    required: true,
  });
  if (!title.ok) return null;
  if (title.value === undefined) return null;
  const titleValue = title.value;
  if (value.notes === null) return null;
  const notes = normalizeOptionalText(value.notes, {
    field: 'notes',
    max: WORK_BOARD_NOTES_MAX_CHARS,
    required: false,
  });
  if (!notes.ok) return null;
  const creator = normalizeWorkBoardCreator(value.creator);
  if (!creator.ok) return null;
  const provenance = normalizeWorkBoardProvenance(value.provenance);
  if (!provenance.ok) return null;
  const createdAt = asSafeInteger(value.createdAt);
  const updatedAt = asSafeInteger(value.updatedAt);
  if (createdAt === null || updatedAt === null) return null;
  const archived = value.archived;
  if (typeof archived !== 'boolean') return null;
  if (archived) {
    const archivedAt = asSafeInteger(value.archivedAt);
    if (archivedAt === null) return null;
    return {
      schemaVersion: WORK_BOARD_ITEM_SCHEMA_VERSION,
      id,
      revision,
      scope: scope.value,
      title: titleValue,
      ...(notes.value === undefined ? {} : { notes: notes.value }),
      state,
      archived: true,
      archivedAt,
      creator: creator.value,
      provenance: provenance.value,
      createdAt,
      updatedAt,
    };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'archivedAt')) return null;
  return {
    schemaVersion: WORK_BOARD_ITEM_SCHEMA_VERSION,
    id,
    revision,
    scope: scope.value,
    title: titleValue,
    ...(notes.value === undefined ? {} : { notes: notes.value }),
    state,
    archived: false,
    creator: creator.value,
    provenance: provenance.value,
    createdAt,
    updatedAt,
  };
}

export function applyWorkBoardItemPatch(
  item: WorkBoardItem,
  patch: UpdateWorkBoardItemInput,
  now: number,
): { item: WorkBoardItem; changed: boolean } {
  const title = patch.title ?? item.title;
  const notes =
    patch.notes === undefined
      ? item.notes
      : typeof patch.notes === 'string' && patch.notes.trim() === ''
        ? undefined
        : (patch.notes ?? undefined);
  const scope = patch.scope ?? item.scope;
  const state = patch.state ?? item.state;
  const changed =
    title !== item.title ||
    notes !== item.notes ||
    !workBoardScopesEqual(scope, item.scope) ||
    state !== item.state;
  if (!changed) return { item, changed: false };
  const { notes: _removedNotes, ...itemWithoutNotes } = item;
  return {
    item: {
      ...itemWithoutNotes,
      title,
      ...(notes === undefined ? {} : { notes }),
      scope,
      state,
      updatedAt: now,
      revision: item.revision + 1,
    },
    changed: true,
  };
}

export function archiveWorkBoardItem(
  item: WorkBoardItem,
  now: number,
): { item: WorkBoardItem; changed: boolean } {
  if (item.archived) return { item, changed: false };
  return {
    item: {
      ...item,
      archived: true,
      archivedAt: now,
      updatedAt: now,
      revision: item.revision + 1,
    },
    changed: true,
  };
}

export function unarchiveWorkBoardItem(
  item: WorkBoardItem,
  now: number,
): { item: WorkBoardItem; changed: boolean } {
  if (!item.archived) return { item, changed: false };
  const { archivedAt: _archivedAt, ...activeFields } = item;
  return {
    item: {
      ...activeFields,
      archived: false,
      updatedAt: now,
      revision: item.revision + 1,
    },
    changed: true,
  };
}

function workBoardScopesEqual(left: WorkBoardScope, right: WorkBoardScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'inbox') return true;
  return right.kind === 'project' && left.projectId === right.projectId;
}

function normalizeOptionalText(
  input: unknown,
  options: { field: string; max: number; required: boolean },
): WorkBoardNormalizeResult<string | undefined> {
  if (input === undefined || input === null) {
    if (options.required) return fail(`${options.field} is required`);
    return { ok: true, value: undefined };
  }
  if (typeof input !== 'string') return fail(`${options.field} must be a string`);
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    if (options.required) return fail(`${options.field} must not be empty`);
    return { ok: true, value: undefined };
  }
  if (trimmed.length > options.max) {
    return fail(`${options.field} exceeds ${options.max} characters`);
  }
  return { ok: true, value: trimmed };
}

function normalizeIdString(
  input: unknown,
  options: { field: string; max: number },
): WorkBoardNormalizeResult<string> {
  if (typeof input !== 'string' || input.trim() !== input || input.length === 0) {
    return fail(`${options.field} must be a non-empty trimmed string`);
  }
  if (input.length > options.max) {
    return fail(`${options.field} exceeds ${options.max} characters`);
  }
  return { ok: true, value: input };
}

function normalizeOptionalToken(
  input: unknown,
  field: string,
): WorkBoardNormalizeResult<string | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  const token = normalizeIdString(input, { field, max: 256 });
  return token;
}

function asSafeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

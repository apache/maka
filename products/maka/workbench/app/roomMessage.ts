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

import type {
  AgentRoomMessage,
  OperationReply,
} from '../../../../packages/plugin-sdk/src/index.js';

export function roomAuthorSession(message: AgentRoomMessage): string | null {
  return message.author.kind === 'session' ? message.author.execution.sessionId : null;
}

export function sameRoomAuthor(a: AgentRoomMessage, b: AgentRoomMessage): boolean {
  if (a.author.kind !== b.author.kind) return false;
  if (a.author.kind === 'human') return true;
  return roomAuthorSession(a) === roomAuthorSession(b);
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when `curr` continues `prev`'s message group (same author, within 5 minutes, same day,
 * neither deleted, and `curr` is not starting a quoted reply).
 */
export function isGroupContinuation(
  prev: AgentRoomMessage | undefined,
  curr: AgentRoomMessage,
): boolean {
  if (!prev) return false;
  if (prev.deletedAt || curr.deletedAt) return false;
  if (curr.replyTo) return false;
  if (!sameRoomAuthor(prev, curr)) return false;
  if (roomDayKey(prev.at) !== roomDayKey(curr.at)) return false;
  return curr.at >= prev.at && curr.at - prev.at < GROUP_WINDOW_MS;
}

/**
 * Detect an active @mention token at the caret.
 * Supports start-of-line, whitespace, punctuation, and CJK text immediately before '@'
 * (e.g. "帮我看下@codex"), while ignoring mid-word ASCII identifiers such as email addresses ("a@b.com").
 */
export function roomMentionAt(text: string, selection: { start: number; end: number }) {
  if (selection.start !== selection.end) return null;
  const before = text.slice(0, selection.start);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/[\s@\]()[\]]/.test(query)) return null;
  if (at > 0) {
    const prev = before[at - 1]!;
    // Reject email / identifier prefixes like "foo@bar" or "user1@host" or inside "[@Title](...)".
    if (/[A-Za-z0-9._+-]/.test(prev) || prev === '[') return null;
  }
  return { start: at, end: selection.start, query };
}

/** Escape Markdown link brackets inside an inline mention token label. */
function escapeMentionLabel(label: string): string {
  return label.replace(/[\\[\]\r\n]/g, (ch) => (ch === '\r' || ch === '\n' ? ' ' : `\\${ch}`));
}

/** Format an inline clickable mention token understood by both SkillInput and the Host. */
export function formatInlineMention(sessionId: string, title: string): string {
  const clean = escapeMentionLabel(title.trim() || sessionId);
  return `[@${clean}](maka://session/${sessionId}) `;
}

const INLINE_MENTION_RE = /\[@(?:\\[^\r\n]|[^\]\\\r\n])+\]\(maka:\/\/session\/([A-Za-z0-9_-]+)\)/g;

/** Extract deduplicated Agent session IDs referenced via inline [@Title](maka://session/<id>) tokens. */
export function extractInlineMentionIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(INLINE_MENTION_RE)) {
    const id = match[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Remove all inline mention tokens targeting a given sessionId from draft text. */
export function stripInlineMention(text: string, sessionId: string): string {
  const escapedId = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\[@(?:\\\\[^\\r\\n]|[^\\]\\\\\\r\\n])+\\]\\(maka://session/${escapedId}\\) ?`,
    'g',
  );
  return text.replace(re, '');
}

const MARKDOWN_LINK_RE = /\[((?:\\[^\r\n]|[^\]\\\r\n])+)\]\((?:[^)\r\n]+)\)/g;

/** Format raw Room message Markdown into clean single/multi-line preview prose for quotes, pins, and search snippets. */
export function formatRoomPreviewText(text: string): string {
  return text
    .replace(MARKDOWN_LINK_RE, (_, label: string) => label.replace(/\\([\[\]\\])/g, '$1'))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Match SkillMessage's plain-vs-markdown heuristic so plain human prose keeps its natural bubble width. */
export function roomTextNeedsMarkdown(text: string): boolean {
  if (!text) return false;
  if (/[\r\n]|!\[/.test(text)) return true;
  return /[#*_~`\[\]<>!\\&@$]|^(?: {4}|\t)|^\s*(?:[-+=]|\d+[.)])|https?:|www\./i.test(text);
}

const AVATAR_PALETTE = [
  '#4F7CAC',
  '#7A68C8',
  '#3D8B74',
  '#C47D3B',
  '#B65A7D',
  '#4E8899',
  '#7D8B3D',
  '#9A63B5',
] as const;

/** Deterministic accent color for an Agent session avatar in Rooms. */
export function roomAvatarColor(id: string): string {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]!;
}

export function roomAvatarInitial(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0]!.toUpperCase();
}

export function roomDayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function workspaceTailName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export type RoomDeliveryReasonKey =
  | 'Reason model unavailable'
  | 'Reason self mention'
  | 'Reason hop limit'
  | 'Reason reply tool unavailable'
  | 'Reason session unavailable'
  | 'Reason not your worker'
  | 'Reason turn stopped'
  | 'Reason room has no backend';

export function roomDeliveryReasonKey(reason: string): RoomDeliveryReasonKey | null {
  switch (reason) {
    case 'agent_model_unavailable':
      return 'Reason model unavailable';
    case 'agent_room_self_mention':
      return 'Reason self mention';
    case 'agent_room_hop_limit_reached':
      return 'Reason hop limit';
    case 'agent_room_reply_tool_unavailable':
      return 'Reason reply tool unavailable';
    case 'agent_session_unavailable':
      return 'Reason session unavailable';
    case 'agent_not_your_worker':
      return 'Reason not your worker';
    case 'agent_turn_stopped':
      return 'Reason turn stopped';
    case 'agent_room_has_no_backend':
      return 'Reason room has no backend';
    default:
      return null;
  }
}

export interface RoomWatchState {
  through: number;
  revision: number | null;
}

export interface RoomWatchActions {
  hasAfterCursor: () => boolean;
  loadedThrough: () => number;
  onThrough: (through: number) => void;
  onUnseenDelta: (delta: number) => void;
  appendNew: (refreshExisting: boolean, targetThrough: number) => Promise<boolean>;
  refreshExisting: () => Promise<boolean>;
}

/**
 * Reconcile one Room watch watermark against the client's loaded timeline state.
 * Only advances `state.through` / `state.revision` after the corresponding read reaches
 * `update.through` (when at the live tail) and completes cleanly.
 */
export async function applyRoomWatchUpdate(
  state: RoomWatchState,
  update: { through: number; revision: number },
  actions: RoomWatchActions,
): Promise<boolean> {
  const revChanged = state.revision === null || update.revision !== state.revision;
  const effectiveThrough = actions.hasAfterCursor()
    ? state.through
    : Math.min(state.through, actions.loadedThrough());
  if (update.through > effectiveThrough) {
    const delta = update.through - effectiveThrough;
    if (actions.hasAfterCursor()) {
      const ok = revChanged ? await actions.refreshExisting() : true;
      if (!ok) return false;
      state.through = update.through;
      actions.onThrough(update.through);
      actions.onUnseenDelta(delta);
      state.revision = update.revision;
      return true;
    }
    const ok = await actions.appendNew(revChanged, update.through);
    const loaded = actions.loadedThrough();
    if (!ok || loaded < update.through) return false;
    state.through = loaded;
    actions.onThrough(loaded);
    state.revision = update.revision;
    return true;
  }
  if (revChanged) {
    const ok = await actions.refreshExisting();
    if (!ok) return false;
    state.revision = update.revision;
  }
  return true;
}

export function roomResult<T>(reply: unknown): T {
  const receipt = (reply as OperationReply).receipt;
  if (receipt.kind !== 'recorded') throw new Error('Operation receipt is not recorded.');
  const outcome = receipt.outcome;
  if (outcome.kind !== 'returned') throw new Error(`Operation outcome: ${outcome.kind}`);
  if (outcome.result.kind === 'failure') throw new Error(outcome.result.diagnostic);
  return outcome.result.value as T;
}

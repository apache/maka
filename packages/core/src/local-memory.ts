/**
 * Transparent local MEMORY.md contract.
 *
 * V0.1 describes one user-visible Markdown file. It does not implement
 * hidden durable memory, extraction, embeddings, recall, or agent tools.
 */

import { redactSecrets } from './redaction.js';

export interface LocalMemorySettings {
  readonly enabled: boolean;
  readonly agentReadEnabled: boolean;
}

export type LocalMemoryOrigin = 'manual' | 'extracted' | 'imported' | 'unknown';
export type LocalMemoryEntryStatus =
  | 'draft'
  | 'review_required'
  | 'active'
  | 'archived'
  | 'rejected'
  | 'unknown';
export type LocalMemoryScope = 'workspace' | 'session';
export type LocalMemorySource = 'user_authored' | 'chat_extracted' | 'unknown';

export interface LocalMemoryEntryPreview {
  readonly id: string;
  readonly origin: LocalMemoryOrigin;
  readonly source: LocalMemorySource;
  readonly status: LocalMemoryEntryStatus;
  readonly title: string;
  readonly content: string;
  readonly scope?: LocalMemoryScope;
  readonly sessionId?: string;
  readonly proposalId?: string;
  readonly sourceTurnId?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly proposedAt?: number;
  readonly confirmedAt?: number;
  readonly archivedAt?: number;
  readonly rejectedAt?: number;
  readonly approvedBy?: 'user';
  readonly approvalSurface?: 'settings_review_queue' | 'inline_approval' | 'manual_editor_save';
  readonly archiveReason?: string;
  readonly tags: readonly string[];
  readonly decayTtlMs?: number;
}

export interface LocalMemoryParseResult {
  readonly entries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly activeEntries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly archivedEntries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly safeMode: boolean;
  readonly reason?: 'empty' | 'oversize';
}

export interface LocalMemoryBackupInfo {
  readonly path: string;
  readonly kind: 'save' | 'reset' | 'restore';
  readonly updatedAt: number;
  readonly sizeBytes: number;
  readonly entryCount: number;
  readonly activeEntryCount: number;
  readonly archivedEntryCount: number;
  readonly safeMode: boolean;
  readonly reason?: string;
}

interface LocalMemoryRawEntry extends LocalMemoryEntryPreview {
  readonly promptContent: string;
}

interface LocalMemoryRawParseResult {
  readonly entries: ReadonlyArray<LocalMemoryRawEntry>;
  readonly activeEntries: ReadonlyArray<LocalMemoryRawEntry>;
  readonly archivedEntries: ReadonlyArray<LocalMemoryRawEntry>;
  readonly safeMode: boolean;
  readonly reason?: 'empty' | 'oversize';
}

export interface LocalMemoryState {
  readonly path: string;
  readonly enabled: boolean;
  readonly agentReadEnabled: boolean;
  readonly status: 'ok' | 'disabled' | 'safe_mode' | 'incognito_blocked' | 'error';
  readonly content: string;
  readonly entryCount: number;
  readonly activeEntryCount: number;
  readonly archivedEntryCount: number;
  readonly entries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly activeEntries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly archivedEntries: ReadonlyArray<LocalMemoryEntryPreview>;
  readonly latestEntry?: LocalMemoryEntryPreview;
  readonly latestBackup?: LocalMemoryBackupInfo;
  readonly backups?: ReadonlyArray<LocalMemoryBackupInfo>;
  readonly reason?: string;
}

export interface AppendManualLocalMemoryEntryInput {
  readonly title: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly now?: number;
}

export type AppendManualLocalMemoryEntryResult =
  | { readonly ok: true; readonly draft: string }
  | { readonly ok: false; readonly reason: 'empty_title' | 'empty_content' | 'oversize' };

export interface AppendApprovedLocalMemoryEntryInput {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly source: 'user_authored' | 'chat_extracted';
  readonly scope?: LocalMemoryScope;
  readonly sessionId?: string;
  readonly proposalId?: string;
  readonly sourceTurnId?: string;
  readonly confirmedAt: number;
  readonly approvalSurface?: 'settings_review_queue' | 'inline_approval' | 'manual_editor_save';
  readonly tags?: readonly string[];
}

export type AppendApprovedLocalMemoryEntryResult =
  | { readonly ok: true; readonly draft: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_id'
        | 'invalid_session_id'
        | 'empty_title'
        | 'empty_content'
        | 'oversize';
    };

export interface AppendLocalMemoryProposalInput {
  readonly proposalId: string;
  readonly title: string;
  readonly content: string;
  readonly scope?: LocalMemoryScope;
  readonly sessionId?: string;
  readonly sourceTurnId?: string;
  readonly proposedAt: number;
  readonly tags?: readonly string[];
}

export type AppendLocalMemoryProposalResult =
  | { readonly ok: true; readonly draft: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_id'
        | 'invalid_session_id'
        | 'empty_title'
        | 'empty_content'
        | 'oversize';
    };

export interface ApproveLocalMemoryProposalInput {
  readonly proposalId: string;
  readonly entryId: string;
  readonly confirmedAt: number;
  readonly approvalSurface?: 'settings_review_queue' | 'inline_approval' | 'manual_editor_save';
}

export type ApproveLocalMemoryProposalResult =
  | {
      readonly ok: true;
      readonly memoryDraft: string;
      readonly pendingDraft: string;
      readonly entry: LocalMemoryEntryPreview;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_id'
        | 'invalid_session_id'
        | 'not_found'
        | 'not_pending'
        | 'empty_content'
        | 'oversize';
    };

export interface RejectLocalMemoryProposalInput {
  readonly proposalId: string;
  readonly rejectedAt: number;
}

export type RejectLocalMemoryProposalResult =
  | { readonly ok: true; readonly draft: string }
  | {
      readonly ok: false;
      readonly reason: 'invalid_id' | 'not_found' | 'not_pending' | 'oversize';
    };

export interface SetLocalMemoryEntryStatusInput {
  readonly id: string;
  readonly status: 'active' | 'archived';
  readonly now?: number;
  readonly archiveReason?: string;
  readonly recordLifecycleMetadata?: boolean;
}

export type SetLocalMemoryEntryStatusResult =
  | { readonly ok: true; readonly draft: string }
  | { readonly ok: false; readonly reason: 'invalid_id' | 'not_found' | 'oversize' };

export interface LocalMemoryEntryDraftRange {
  readonly start: number;
  readonly end: number;
}

export interface LocalMemoryEntryDraft {
  readonly id: string;
  readonly title: string;
  readonly status: LocalMemoryEntryStatus;
  readonly content: string;
  readonly scope?: LocalMemoryScope;
  readonly sessionId?: string;
  readonly proposalId?: string;
  readonly sourceTurnId?: string;
}

export const LOCAL_MEMORY_MAX_BYTES = 128 * 1024;
export const LOCAL_MEMORY_PROMPT_MAX_CHARS = 12_000;
export const LOCAL_MEMORY_PROMPT_TRUNCATION_MARKER = '[本地记忆已按长度截断]';

export interface LocalMemoryPromptContext {
  readonly sessionId?: string;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

export function defaultLocalMemorySettings(): LocalMemorySettings {
  return { enabled: true, agentReadEnabled: false };
}

export function normalizeLocalMemorySettings(input: unknown): LocalMemorySettings {
  if (!input || typeof input !== 'object') return defaultLocalMemorySettings();
  const value = input as Partial<LocalMemorySettings>;
  return {
    enabled: value.enabled !== false,
    agentReadEnabled: value.agentReadEnabled === true,
  };
}

export function defaultLocalMemoryMarkdown(now = Date.now()): string {
  const exampleContent =
    '这里写你希望 Maka 记住的长期偏好。默认不会注入给 agent；需要在设置里单独开启“agent 可读取本地记忆”。';
  const exampleId = stableLocalMemoryEntryId(exampleContent, now);
  return [
    '# Maka Memory',
    '',
    '## 示例：我的偏好',
    `<!-- maka-memory: id=${exampleId} origin=manual createdAt=${now} -->`,
    exampleContent,
    '',
  ].join('\n');
}

export function parseLocalMemoryMarkdown(input: string): LocalMemoryParseResult {
  const parsed = parseLocalMemoryMarkdownRaw(input);
  if (parsed.safeMode || parsed.reason) return parsed;
  return toPreviewParseResult(parsed);
}

export function buildLocalMemoryPromptBody(
  input: string,
  context: LocalMemoryPromptContext = {},
): string | undefined {
  const parsed = parseLocalMemoryMarkdownRaw(input);
  if (parsed.safeMode || parsed.activeEntries.length === 0) return undefined;

  const sessionId = normalizeMetaValue(context.sessionId ?? '');
  const visibleEntries = parsed.activeEntries.filter(
    (entry) => entry.scope !== 'session' || (sessionId.length > 0 && entry.sessionId === sessionId),
  );
  const blocks = visibleEntries.map((entry) => {
    const lines = [`## ${entry.title}`];
    if (entry.tags.length > 0) lines.push(`Tags: ${entry.tags.join(', ')}`);
    lines.push(entry.promptContent);
    return redactSecrets(lines.join('\n'));
  });
  const body = blocks.join('\n\n').trim();
  if (body.length === 0) return undefined;
  if (body.length <= LOCAL_MEMORY_PROMPT_MAX_CHARS) return body;
  const truncated = body.slice(0, LOCAL_MEMORY_PROMPT_MAX_CHARS);
  const boundarySafe = /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
  return `${boundarySafe.trimEnd()}\n\n${LOCAL_MEMORY_PROMPT_TRUNCATION_MARKER}`;
}

export function appendManualLocalMemoryEntryDraft(
  currentDraft: string,
  input: AppendManualLocalMemoryEntryInput,
): AppendManualLocalMemoryEntryResult {
  const title = normalizeManualEntryTitle(input.title);
  if (!title) return { ok: false, reason: 'empty_title' };

  const content = input.content.trim();
  if (!content) return { ok: false, reason: 'empty_content' };

  const now =
    Number.isFinite(input.now) && input.now !== undefined
      ? Math.max(0, Math.floor(input.now))
      : Date.now();
  const tags = normalizeManualEntryTags(input.tags ?? []);
  const id = stableLocalMemoryEntryId(content, now);
  const meta = [
    `id=${id}`,
    'origin=manual',
    `createdAt=${now}`,
    'status=active',
    ...(tags.length > 0 ? [`tags=${tags.join(',')}`] : []),
  ].join(' ');
  const entry = [`## ${title}`, `<!-- maka-memory: ${meta} -->`, content].join('\n');
  const draft =
    currentDraft.trim().length > 0 ? `${currentDraft.trimEnd()}\n\n${entry}\n` : `${entry}\n`;
  if (new TextEncoder().encode(draft).byteLength > LOCAL_MEMORY_MAX_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  return { ok: true, draft };
}

export function appendApprovedLocalMemoryEntryDraft(
  currentDraft: string,
  input: AppendApprovedLocalMemoryEntryInput,
): AppendApprovedLocalMemoryEntryResult {
  const id = normalizeId(input.id, 'mem-');
  if (!id) return { ok: false, reason: 'invalid_id' };

  const title = normalizeManualEntryTitle(input.title);
  if (!title) return { ok: false, reason: 'empty_title' };

  const content = input.content.trim();
  if (!content) return { ok: false, reason: 'empty_content' };

  const confirmedAt = normalizeTimestamp(input.confirmedAt);
  const tags = normalizeManualEntryTags(input.tags ?? []);
  const source = input.source === 'chat_extracted' ? 'chat_extracted' : 'user_authored';
  const origin = source === 'chat_extracted' ? 'extracted' : 'manual';
  const scope = input.scope === 'session' ? 'session' : 'workspace';
  const sessionId = normalizeScopedSessionId(scope, input.sessionId);
  if (sessionId === null) return { ok: false, reason: 'invalid_session_id' };
  const meta = [
    `id=${id}`,
    `origin=${origin}`,
    `source=${source}`,
    `createdAt=${confirmedAt}`,
    `updatedAt=${confirmedAt}`,
    `confirmedAt=${confirmedAt}`,
    'status=active',
    `scope=${scope}`,
    ...(sessionId ? [`sessionId=${sessionId}`] : []),
    'approvedBy=user',
    `approvalSurface=${input.approvalSurface ?? (source === 'chat_extracted' ? 'settings_review_queue' : 'manual_editor_save')}`,
    ...(input.proposalId ? [`proposalId=${normalizeId(input.proposalId, 'proposal-')}`] : []),
    ...(input.sourceTurnId ? [`sourceTurnId=${normalizeMetaValue(input.sourceTurnId)}`] : []),
    ...(tags.length > 0 ? [`tags=${tags.join(',')}`] : []),
  ].join(' ');
  return appendEntrySection(currentDraft, title, meta, content);
}

export function appendLocalMemoryProposalDraft(
  currentDraft: string,
  input: AppendLocalMemoryProposalInput,
): AppendLocalMemoryProposalResult {
  const proposalId = normalizeId(input.proposalId, 'proposal-');
  if (!proposalId) return { ok: false, reason: 'invalid_id' };

  const title = normalizeManualEntryTitle(input.title);
  if (!title) return { ok: false, reason: 'empty_title' };

  const content = input.content.trim();
  if (!content) return { ok: false, reason: 'empty_content' };

  const proposedAt = normalizeTimestamp(input.proposedAt);
  const tags = normalizeManualEntryTags(input.tags ?? []);
  const scope = input.scope === 'session' ? 'session' : 'workspace';
  const sessionId = normalizeScopedSessionId(scope, input.sessionId);
  if (sessionId === null) return { ok: false, reason: 'invalid_session_id' };
  const meta = [
    `id=${proposalId}`,
    `proposalId=${proposalId}`,
    'origin=extracted',
    'source=chat_extracted',
    `proposedAt=${proposedAt}`,
    'status=review_required',
    `scope=${scope}`,
    ...(sessionId ? [`sessionId=${sessionId}`] : []),
    ...(input.sourceTurnId ? [`sourceTurnId=${normalizeMetaValue(input.sourceTurnId)}`] : []),
    ...(tags.length > 0 ? [`tags=${tags.join(',')}`] : []),
  ].join(' ');
  return appendEntrySection(currentDraft, title, meta, content);
}

export function stableLocalMemoryEntryId(content: string, createdAt: number): string {
  const normalizedCreatedAt = Number.isFinite(createdAt) ? Math.max(0, Math.floor(createdAt)) : 0;
  return `mem-${sha256Hex(`${content.trim()}\n${normalizedCreatedAt}`).slice(0, 16)}`;
}

export function stableLocalMemoryProposalId(content: string, proposedAt: number): string {
  const normalizedProposedAt = Number.isFinite(proposedAt)
    ? Math.max(0, Math.floor(proposedAt))
    : 0;
  return `proposal-${sha256Hex(`${content.trim()}\n${normalizedProposedAt}`).slice(0, 16)}`;
}

export function setLocalMemoryEntryStatusDraft(
  currentDraft: string,
  input: SetLocalMemoryEntryStatusInput,
): SetLocalMemoryEntryStatusResult {
  const id = input.id.trim();
  if (!id || (input.status !== 'active' && input.status !== 'archived')) {
    return { ok: false, reason: 'invalid_id' };
  }

  const section = findLocalMemoryEntrySection(currentDraft, id);
  if (!section) return { ok: false, reason: 'not_found' };

  const now =
    Number.isFinite(input.now) && input.now !== undefined
      ? Math.max(0, Math.floor(input.now))
      : Date.now();
  const lines = currentDraft.split(/\r?\n/);
  const meta = {
    ...(section.meta ?? {}),
    id: section.id,
    status: input.status,
    updatedAt: String(now),
    ...(input.status === 'archived' && input.recordLifecycleMetadata
      ? { archivedAt: String(now) }
      : {}),
    ...(input.status === 'archived' && input.recordLifecycleMetadata && input.archiveReason
      ? { archiveReason: normalizeMetaValue(input.archiveReason) }
      : {}),
  };
  const metaLine = `<!-- maka-memory: ${serializeMetaComment(meta)} -->`;

  if (section.metaLineIndex !== undefined) {
    lines[section.metaLineIndex] = metaLine;
  } else {
    lines.splice(section.headingLineIndex + 1, 0, metaLine);
  }

  const draft = lines.join('\n');
  if (new TextEncoder().encode(draft).byteLength > LOCAL_MEMORY_MAX_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  return { ok: true, draft };
}

export function approveLocalMemoryProposalDraft(
  memoryDraft: string,
  pendingDraft: string,
  input: ApproveLocalMemoryProposalInput,
): ApproveLocalMemoryProposalResult {
  const proposalId = normalizeId(input.proposalId, 'proposal-');
  const entryId = normalizeId(input.entryId, 'mem-');
  if (!proposalId || !entryId) return { ok: false, reason: 'invalid_id' };

  const proposal = findLocalMemoryEntryFullSection(pendingDraft, proposalId);
  if (!proposal) return { ok: false, reason: 'not_found' };
  const status = normalizeEntryStatus(proposal.meta?.status, true);
  if (status !== 'draft' && status !== 'review_required')
    return { ok: false, reason: 'not_pending' };
  if (!proposal.content.trim()) return { ok: false, reason: 'empty_content' };

  const approved = appendApprovedLocalMemoryEntryDraft(memoryDraft, {
    id: entryId,
    title: proposal.title,
    content: proposal.content,
    source: 'chat_extracted',
    scope: normalizeScope(proposal.meta?.scope),
    sessionId: proposal.meta?.sessionId,
    proposalId,
    sourceTurnId: proposal.meta?.sourceTurnId,
    confirmedAt: input.confirmedAt,
    approvalSurface: input.approvalSurface ?? 'settings_review_queue',
    tags: parseTags(proposal.meta?.tags),
  });
  if (!approved.ok) {
    switch (approved.reason) {
      case 'oversize':
      case 'invalid_session_id':
        return { ok: false, reason: approved.reason };
      default:
        return { ok: false, reason: 'empty_content' };
    }
  }

  const pendingWithoutProposal = removeLocalMemoryEntrySection(pendingDraft, proposal.range);
  if (new TextEncoder().encode(pendingWithoutProposal).byteLength > LOCAL_MEMORY_MAX_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  const parsed = parseLocalMemoryMarkdown(approved.draft);
  const entry = parsed.activeEntries.find((candidate) => candidate.id === entryId);
  if (!entry) return { ok: false, reason: 'not_found' };
  return { ok: true, memoryDraft: approved.draft, pendingDraft: pendingWithoutProposal, entry };
}

export function rejectLocalMemoryProposalDraft(
  currentDraft: string,
  input: RejectLocalMemoryProposalInput,
): RejectLocalMemoryProposalResult {
  const proposalId = normalizeId(input.proposalId, 'proposal-');
  if (!proposalId) return { ok: false, reason: 'invalid_id' };
  const section = findLocalMemoryEntrySection(currentDraft, proposalId);
  if (!section) return { ok: false, reason: 'not_found' };
  const status = normalizeEntryStatus(section.meta?.status, true);
  if (status !== 'draft' && status !== 'review_required')
    return { ok: false, reason: 'not_pending' };

  const rejectedAt = normalizeTimestamp(input.rejectedAt);
  const lines = currentDraft.split(/\r?\n/);
  const meta = {
    ...(section.meta ?? {}),
    id: section.id,
    proposalId,
    status: 'rejected',
    rejectedAt: String(rejectedAt),
  };
  const metaLine = `<!-- maka-memory: ${serializeMetaComment(meta)} -->`;
  if (section.metaLineIndex !== undefined) {
    lines[section.metaLineIndex] = metaLine;
  } else {
    lines.splice(section.headingLineIndex + 1, 0, metaLine);
  }

  const draft = lines.join('\n');
  if (new TextEncoder().encode(draft).byteLength > LOCAL_MEMORY_MAX_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  return { ok: true, draft };
}

export function findLocalMemoryEntryDraftRange(
  input: string,
  entryId: string,
): LocalMemoryEntryDraftRange | null {
  const id = entryId.trim();
  if (!id) return null;

  const lines = input.split(/\r?\n/);
  const lineStarts: number[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    lineStarts[index] = offset;
    offset += (lines[index] ?? '').length;
    if (index < lines.length - 1) {
      offset += input[offset] === '\r' && input[offset + 1] === '\n' ? 2 : 1;
    }
  }
  lineStarts[lines.length] = input.length;

  let current: { title: string; headingLineIndex: number; meta?: Record<string, string> } | null =
    null;

  const matchCurrent = (endLineIndex: number): LocalMemoryEntryDraftRange | null => {
    if (!current) return null;
    const currentId = current.meta?.id ?? slugId(current.title);
    if (currentId !== id) return null;
    return {
      start: lineStarts[current.headingLineIndex] ?? 0,
      end: lineStarts[endLineIndex] ?? input.length,
    };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const matched = matchCurrent(index);
      if (matched) return matched;
      current = { title: heading[1] ?? '未命名记忆', headingLineIndex: index };
      continue;
    }
    if (!current || current.meta) continue;
    const meta = parseMetaComment(line);
    if (meta) current.meta = meta;
  }
  return matchCurrent(lines.length);
}

export function findLocalMemoryEntryDraft(
  input: string,
  entryId: string,
): LocalMemoryEntryDraft | null {
  const section = findLocalMemoryEntryFullSection(input, entryId);
  if (!section) return null;
  const id = section.meta?.id ?? slugId(section.title);
  return {
    id,
    title: section.title,
    status: normalizeEntryStatus(section.meta?.status, false),
    content: section.content,
    scope: normalizeScope(section.meta?.scope),
    ...(section.meta?.sessionId ? { sessionId: section.meta.sessionId } : {}),
    ...(section.meta?.proposalId ? { proposalId: section.meta.proposalId } : {}),
    ...(section.meta?.sourceTurnId ? { sourceTurnId: section.meta.sourceTurnId } : {}),
  };
}

function parseLocalMemoryMarkdownRaw(input: string): LocalMemoryRawParseResult {
  const size = new TextEncoder().encode(input).byteLength;
  if (size > LOCAL_MEMORY_MAX_BYTES) {
    return {
      entries: [],
      activeEntries: [],
      archivedEntries: [],
      safeMode: true,
      reason: 'oversize',
    };
  }
  if (input.trim().length === 0) {
    return {
      entries: [],
      activeEntries: [],
      archivedEntries: [],
      safeMode: false,
      reason: 'empty',
    };
  }

  const entries: LocalMemoryRawEntry[] = [];
  const lines = input.split(/\r?\n/);
  let current: { title: string; body: string[]; meta?: Record<string, string> } | null = null;

  const flush = () => {
    if (!current) return;
    const content = current.body.join('\n').trim();
    if (content.length > 0) {
      const id = current.meta?.id || slugId(current.title);
      const origin = normalizeOrigin(current.meta?.origin);
      const source = normalizeSource(current.meta?.source, origin);
      const status = normalizeEntryStatus(current.meta?.status, false);
      const scope = normalizeScope(current.meta?.scope);
      const createdAt = parseFiniteNumber(current.meta?.createdAt);
      const updatedAt = parseFiniteNumber(current.meta?.updatedAt);
      const proposedAt = parseFiniteNumber(current.meta?.proposedAt);
      const confirmedAt = parseFiniteNumber(current.meta?.confirmedAt);
      const archivedAt = parseFiniteNumber(current.meta?.archivedAt);
      const rejectedAt = parseFiniteNumber(current.meta?.rejectedAt);
      const decayTtlMs = parseFiniteNumber(current.meta?.decayTtlMs);
      const approvedBy = current.meta?.approvedBy === 'user' ? 'user' : undefined;
      const approvalSurface = normalizeApprovalSurface(current.meta?.approvalSurface);
      entries.push({
        id,
        origin,
        source,
        status,
        title: current.title,
        content: content.slice(0, 500),
        promptContent: content,
        scope,
        ...(current.meta?.sessionId ? { sessionId: current.meta.sessionId } : {}),
        ...(current.meta?.proposalId ? { proposalId: current.meta.proposalId } : {}),
        ...(current.meta?.sourceTurnId ? { sourceTurnId: current.meta.sourceTurnId } : {}),
        ...(Number.isFinite(createdAt) ? { createdAt } : {}),
        ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
        ...(Number.isFinite(proposedAt) ? { proposedAt } : {}),
        ...(Number.isFinite(confirmedAt) ? { confirmedAt } : {}),
        ...(Number.isFinite(archivedAt) ? { archivedAt } : {}),
        ...(Number.isFinite(rejectedAt) ? { rejectedAt } : {}),
        ...(approvedBy ? { approvedBy } : {}),
        ...(approvalSurface ? { approvalSurface } : {}),
        ...(current.meta?.archiveReason ? { archiveReason: current.meta.archiveReason } : {}),
        tags: parseTags(current.meta?.tags),
        ...(Number.isFinite(decayTtlMs) ? { decayTtlMs } : {}),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[1] ?? '未命名记忆', body: [] };
      continue;
    }
    if (!current) continue;
    const meta = parseMetaComment(line);
    if (meta) {
      current.meta ??= meta;
      continue;
    }
    current.body.push(line);
  }
  flush();
  const archivedEntries = entries.filter((entry) => entry.status === 'archived');
  const activeEntries = entries.filter((entry) => entry.status === 'active');
  return { entries, activeEntries, archivedEntries, safeMode: false };
}

function toPreviewParseResult(parsed: LocalMemoryRawParseResult): LocalMemoryParseResult {
  const entries = parsed.entries.map(stripPromptContent);
  return {
    ...parsed,
    entries,
    activeEntries: entries.filter((entry) => entry.status === 'active'),
    archivedEntries: entries.filter((entry) => entry.status === 'archived'),
  };
}

function stripPromptContent(entry: LocalMemoryRawEntry): LocalMemoryEntryPreview {
  const { promptContent: _promptContent, ...preview } = entry;
  return preview;
}

function parseMetaComment(line: string): Record<string, string> | null {
  const match = /^<!--\s*maka-memory:\s*(.*?)\s*-->$/.exec(line.trim());
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const part of (match[1] ?? '').split(/\s+/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) && value.length <= 128) {
      meta[key] = value;
    }
  }
  return meta;
}

function findLocalMemoryEntrySection(
  input: string,
  entryId: string,
): {
  id: string;
  headingLineIndex: number;
  metaLineIndex?: number;
  meta?: Record<string, string>;
} | null {
  const lines = input.split(/\r?\n/);
  let current: {
    title: string;
    headingLineIndex: number;
    metaLineIndex?: number;
    meta?: Record<string, string>;
  } | null = null;

  const matchCurrent = () => {
    if (!current) return null;
    const id = current.meta?.id || slugId(current.title);
    const proposalId = current.meta?.proposalId;
    return id === entryId || proposalId === entryId ? { id, ...current } : null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const matched = matchCurrent();
      if (matched) return matched;
      current = { title: heading[1] ?? '未命名记忆', headingLineIndex: index };
      continue;
    }
    if (!current || current.meta) continue;
    const meta = parseMetaComment(line);
    if (meta) {
      current.meta = meta;
      current.metaLineIndex = index;
    }
  }
  return matchCurrent();
}

function findLocalMemoryEntryFullSection(
  input: string,
  entryId: string,
): {
  title: string;
  meta?: Record<string, string>;
  content: string;
  range: LocalMemoryEntryDraftRange;
} | null {
  const id = entryId.trim();
  if (!id) return null;

  const lines = input.split(/\r?\n/);
  const lineStarts: number[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    lineStarts[index] = offset;
    offset += (lines[index] ?? '').length;
    if (index < lines.length - 1)
      offset += input[offset] === '\r' && input[offset + 1] === '\n' ? 2 : 1;
  }
  lineStarts[lines.length] = input.length;

  let current: {
    title: string;
    headingLineIndex: number;
    body: string[];
    meta?: Record<string, string>;
  } | null = null;

  const matchCurrent = (endLineIndex: number) => {
    if (!current) return null;
    const currentId = current.meta?.id ?? slugId(current.title);
    const proposalId = current.meta?.proposalId;
    if (currentId !== id && proposalId !== id) return null;
    return {
      title: current.title,
      meta: current.meta,
      content: current.body.join('\n').trim(),
      range: {
        start: lineStarts[current.headingLineIndex] ?? 0,
        end: lineStarts[endLineIndex] ?? input.length,
      },
    };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const matched = matchCurrent(index);
      if (matched) return matched;
      current = { title: heading[1] ?? '未命名记忆', headingLineIndex: index, body: [] };
      continue;
    }
    if (!current) continue;
    const meta = parseMetaComment(line);
    if (meta) {
      current.meta ??= meta;
      continue;
    }
    current.body.push(line);
  }
  return matchCurrent(lines.length);
}

function removeLocalMemoryEntrySection(input: string, range: LocalMemoryEntryDraftRange): string {
  const before = input.slice(0, range.start).replace(/\n{3,}$/g, '\n\n');
  const after = input.slice(range.end).replace(/^\n{2,}/g, '\n');
  return `${before}${after}`.trimEnd() + '\n';
}

function serializeMetaComment(meta: Record<string, string>): string {
  const orderedKeys = [
    'id',
    'proposalId',
    'origin',
    'source',
    'createdAt',
    'updatedAt',
    'status',
    'proposedAt',
    'confirmedAt',
    'archivedAt',
    'rejectedAt',
    'scope',
    'sessionId',
    'approvedBy',
    'approvalSurface',
    'sourceTurnId',
    'archiveReason',
    'tags',
    'decayTtlMs',
  ];
  const seen = new Set<string>();
  const parts: string[] = [];

  const push = (key: string) => {
    if (seen.has(key)) return;
    const value = meta[key];
    if (value === undefined) return;
    const safeValue = value
      .replace(/[\s<>]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 128);
    if (!safeValue) return;
    seen.add(key);
    parts.push(`${key}=${safeValue}`);
  };

  for (const key of orderedKeys) push(key);
  for (const key of Object.keys(meta).sort()) {
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) push(key);
  }
  return parts.join(' ');
}

function appendEntrySection(
  currentDraft: string,
  title: string,
  meta: string,
  content: string,
):
  | { readonly ok: true; readonly draft: string }
  | { readonly ok: false; readonly reason: 'oversize' } {
  const entry = [`## ${title}`, `<!-- maka-memory: ${meta} -->`, content].join('\n');
  const draft =
    currentDraft.trim().length > 0 ? `${currentDraft.trimEnd()}\n\n${entry}\n` : `${entry}\n`;
  if (new TextEncoder().encode(draft).byteLength > LOCAL_MEMORY_MAX_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  return { ok: true, draft };
}

function normalizeManualEntryTitle(input: string): string {
  return input
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeManualEntryTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input) {
    const tag = raw
      .replace(/[\s,]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim()
      .slice(0, 24);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

function normalizeId(input: string, prefix: 'mem-' | 'proposal-'): string {
  const value = input.trim();
  if (!value.startsWith(prefix)) return '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,80}$/.test(value)) return '';
  return value;
}

function normalizeTimestamp(input: number): number {
  return Number.isFinite(input) && input >= 0 ? Math.floor(input) : Date.now();
}

function normalizeMetaValue(input: string): string {
  return input
    .replace(/[\s<>]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

function normalizeScopedSessionId(
  scope: LocalMemoryScope,
  input: string | undefined,
): string | null | undefined {
  if (scope !== 'session') return undefined;
  const sessionId = normalizeMetaValue(input ?? '');
  return sessionId || null;
}

function normalizeOrigin(input: string | undefined): LocalMemoryOrigin {
  switch (input) {
    case 'manual':
    case 'extracted':
    case 'imported':
      return input;
    default:
      return 'unknown';
  }
}

function normalizeSource(input: string | undefined, origin: LocalMemoryOrigin): LocalMemorySource {
  switch (input) {
    case 'user_authored':
    case 'chat_extracted':
      return input;
    default:
      if (origin === 'manual') return 'user_authored';
      if (origin === 'extracted') return 'chat_extracted';
      return 'unknown';
  }
}

function normalizeEntryStatus(
  input: string | undefined,
  missingIsPending: boolean,
): LocalMemoryEntryStatus {
  switch (input) {
    case undefined:
      return missingIsPending ? 'review_required' : 'active';
    case 'draft':
    case 'review_required':
    case 'active':
    case 'archived':
    case 'rejected':
      return input;
    default:
      return 'unknown';
  }
}

function normalizeScope(input: string | undefined): LocalMemoryScope {
  return input === 'session' ? 'session' : 'workspace';
}

function normalizeApprovalSurface(
  input: string | undefined,
): LocalMemoryEntryPreview['approvalSurface'] | undefined {
  switch (input) {
    case 'settings_review_queue':
    case 'inline_approval':
    case 'manual_editor_save':
      return input;
    default:
      return undefined;
  }
}

function parseFiniteNumber(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseTags(input: string | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input.split(',')) {
    const tag = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

function slugId(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'memory-entry';
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(w[i - 15]!, 7) ^ rotateRight(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotateRight(w[i - 2]!, 17) ^ rotateRight(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = add32(w[i - 16]!, s0, w[i - 7]!, s1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = add32(h, s1, ch, SHA256_K[i]!, w[i]!);
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = add32(s0, maj);
      h = g;
      g = f;
      f = e;
      e = add32(d, temp1);
      d = c;
      c = b;
      b = a;
      a = add32(temp1, temp2);
    }

    h0 = add32(h0, a);
    h1 = add32(h1, b);
    h2 = add32(h2, c);
    h3 = add32(h3, d);
    h4 = add32(h4, e);
    h5 = add32(h5, f);
    h6 = add32(h6, g);
    h7 = add32(h7, h);
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function add32(...values: readonly number[]): number {
  let result = 0;
  for (const value of values) result = (result + value) >>> 0;
  return result;
}

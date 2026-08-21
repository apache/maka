/**
 * Transparent local MEMORY.md contract.
 *
 * V0.1 describes one user-visible Markdown file. It does not implement
 * hidden durable memory, extraction, embeddings, recall, or agent tools.
 */

import type { Sha256Digest } from './oauth-subscription.js';
import { redactSecrets } from './redaction.js';

export type { Sha256Digest };

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
  readonly sha256: Sha256Digest;
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

export function defaultLocalMemoryMarkdown(sha256: Sha256Digest, now = Date.now()): string {
  const exampleContent =
    '这里写你希望 Maka 记住的长期偏好。默认不会提供给模型；需要在设置里单独开启“模型上下文可读取”。';
  const { timestamp } = stableLocalMemoryIdMaterial(exampleContent, now);
  const exampleId = stableLocalMemoryEntryId(exampleContent, timestamp, sha256);
  return [
    '# Maka Memory',
    '',
    '## 示例：我的偏好',
    `<!-- maka-memory: id=${exampleId} origin=manual createdAt=${timestamp} -->`,
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
  const id = stableLocalMemoryEntryId(content, now, input.sha256);
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

export function stableLocalMemoryIdMaterial(
  content: string,
  timestamp: number,
): { readonly timestamp: number; readonly material: string } {
  const normalized = Number.isFinite(timestamp) ? Math.max(0, Math.floor(timestamp)) : 0;
  return { timestamp: normalized, material: `${content.trim()}\n${normalized}` };
}

export function stableLocalMemoryEntryId(
  content: string,
  createdAt: number,
  sha256: Sha256Digest,
): string {
  const { material } = stableLocalMemoryIdMaterial(content, createdAt);
  return `mem-${hexSha256(sha256, material).slice(0, 16)}`;
}

export function stableLocalMemoryProposalId(
  content: string,
  proposedAt: number,
  sha256: Sha256Digest,
): string {
  const { material } = stableLocalMemoryIdMaterial(content, proposedAt);
  return `proposal-${hexSha256(sha256, material).slice(0, 16)}`;
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
    const safeValue = normalizeMetaValue(value);
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

function hexSha256(sha256: Sha256Digest, input: string): string {
  return Array.from(sha256.digest(input), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

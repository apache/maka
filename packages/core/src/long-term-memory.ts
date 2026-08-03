/**
 * Atomic long-term-memory contracts.
 *
 * This module contains no storage, model, prompt, or UI dependencies. The
 * existing MEMORY.md bundle remains a separate legacy product surface while
 * the automatic memory lifecycle is introduced incrementally.
 */

export const MEMORY_ITEM_KINDS = [
  'preference',
  'identity',
  'context',
  'knowledge',
  'failure',
  'note',
] as const;
export type MemoryItemKind = (typeof MEMORY_ITEM_KINDS)[number];

export const MEMORY_STATEMENT_TYPES = ['fact', 'plan', 'prediction'] as const;
export type MemoryStatementType = (typeof MEMORY_STATEMENT_TYPES)[number];

export const MEMORY_TEMPORAL_TYPES = ['undated', 'point', 'interval', 'open_ended'] as const;
export type MemoryTemporalType = (typeof MEMORY_TEMPORAL_TYPES)[number];

export const MEMORY_SCOPE_TYPES = ['global', 'workspace'] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export const MEMORY_LIFECYCLE_STATES = ['active', 'archived'] as const;
export type MemoryLifecycleState = (typeof MEMORY_LIFECYCLE_STATES)[number];

export const MEMORY_ITEM_ORIGINS = ['agent_extracted', 'user_requested'] as const;
export type MemoryItemOrigin = (typeof MEMORY_ITEM_ORIGINS)[number];

export const MEMORY_KEY_TYPES = ['exact', 'entity', 'concept', 'alias', 'code'] as const;
export type MemoryKeyType = (typeof MEMORY_KEY_TYPES)[number];

export const MEMORY_KEY_ORIGINS = ['deterministic', 'llm', 'user'] as const;
export type MemoryKeyOrigin = (typeof MEMORY_KEY_ORIGINS)[number];

export const MEMORY_MUTATION_TYPES = ['create', 'update', 'archive', 'restore'] as const;
export type MemoryMutationType = (typeof MEMORY_MUTATION_TYPES)[number];
export type MemoryWriteOperationType = MemoryMutationType | 'batch';

export const LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS = 2_000;

const LONG_TERM_MEMORY_CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'g',
);
const LONG_TERM_MEMORY_ZERO_WIDTH_CHARS = new RegExp(
  `[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d)}${String.fromCharCode(0xfeff)}]`,
  'g',
);
const LONG_TERM_MEMORY_SURROGATE_CHARS = /\p{Cs}/u;

export interface MemoryItem {
  readonly itemId: string;
  readonly version: number;
  readonly content: string;
  readonly kind: MemoryItemKind;
  readonly statementType: MemoryStatementType;
  readonly temporalType: MemoryTemporalType;
  readonly scopeType: MemoryScopeType;
  readonly scopeKey: string | null;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly observedAt: number;
  readonly lifecycleState: MemoryLifecycleState;
  /** How the current content was produced, not how this stable Item was first created. */
  readonly origin: MemoryItemOrigin;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryItemKeyInput {
  readonly key: string;
  readonly keyType: MemoryKeyType;
  readonly keyOrigin: MemoryKeyOrigin;
}

export interface MemoryItemKey extends MemoryItemKeyInput {
  readonly normalizedKey: string;
}

/** Durable provenance for the current Item content. */
export interface MemoryItemSource {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly eventId: string;
}

/** Complete current-fact state admitted by trusted Runtime code. */
export interface MemoryItemWrite {
  readonly content: string;
  readonly kind: MemoryItemKind;
  readonly statementType: MemoryStatementType;
  readonly temporalType: MemoryTemporalType;
  readonly scopeType: MemoryScopeType;
  readonly scopeKey?: string | null;
  readonly eventStartedAt?: number | null;
  readonly eventEndedAt?: number | null;
  /** Derived by Runtime from the supporting source Events. */
  readonly observedAt: number;
  readonly origin: MemoryItemOrigin;
  readonly keys: readonly MemoryItemKeyInput[];
  readonly sources: readonly MemoryItemSource[];
}

export interface CreateMemoryItemMutation {
  readonly type: 'create';
  readonly item: MemoryItemWrite;
}

export interface UpdateMemoryItemMutation {
  readonly type: 'update';
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly item: MemoryItemWrite;
}

export interface ArchiveMemoryItemMutation {
  readonly type: 'archive';
  readonly itemId: string;
  readonly expectedVersion: number;
}

export interface RestoreMemoryItemMutation {
  readonly type: 'restore';
  readonly itemId: string;
  readonly expectedVersion: number;
}

export type MemoryItemMutation =
  | CreateMemoryItemMutation
  | UpdateMemoryItemMutation
  | ArchiveMemoryItemMutation
  | RestoreMemoryItemMutation;

export interface ApplyMemoryMutationsRequest {
  readonly operationId: string;
  /** The Store applies the complete list atomically under one idempotency receipt. */
  readonly mutations: readonly MemoryItemMutation[];
}

export type MemoryMutationOutcome = 'created' | 'updated' | 'archived' | 'restored' | 'noop';

export interface MemoryMutationResult {
  readonly mutationIndex: number;
  readonly mutationType: MemoryMutationType;
  readonly itemId: string;
  readonly version: number;
  readonly lifecycleState: MemoryLifecycleState;
  readonly outcome: MemoryMutationOutcome;
}

export interface MemoryWriteOperationResult {
  readonly operationId: string;
  readonly operationType: MemoryWriteOperationType;
  readonly replayed: boolean;
  readonly committedAt: number;
  readonly results: readonly MemoryMutationResult[];
}

export interface MemoryItemRecord {
  readonly item: MemoryItem;
  readonly keys: readonly MemoryItemKey[];
  readonly sources: readonly MemoryItemSource[];
}

export interface SearchMemoryItemsByKeyRequest {
  /** Match any distinct term and rank Items by the number of matched terms. */
  readonly terms: readonly string[];
  readonly match: 'exact' | 'prefix';
  /** Omit to search global Items only; provide to include global plus this workspace. */
  readonly workspaceKey?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export interface MemoryItemStore {
  applyMutations(request: ApplyMemoryMutationsRequest): Promise<MemoryWriteOperationResult>;
  readItem(itemId: string): Promise<MemoryItemRecord | undefined>;
  searchByKeys(request: SearchMemoryItemsByKeyRequest): Promise<readonly MemoryItemRecord[]>;
  readOperation(operationId: string): Promise<MemoryWriteOperationResult | undefined>;
}

export type MemoryItemStoreConflictReason =
  | 'operation_reused'
  | 'version_conflict'
  | 'duplicate_active'
  | 'duplicate_within_batch'
  | 'item_not_found'
  | 'invalid_lifecycle_transition';

export class MemoryItemStoreConflictError extends Error {
  readonly name = 'MemoryItemStoreConflictError';

  constructor(
    readonly reason: MemoryItemStoreConflictReason,
    message: string,
    readonly itemId?: string,
    readonly conflictingItemId?: string,
  ) {
    super(message);
  }
}

export function normalizeLongTermMemoryContent(
  input: unknown,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string } {
  if (typeof input !== 'string') {
    return { ok: false, message: 'Long-term Memory Item content must be a string' };
  }
  if (LONG_TERM_MEMORY_SURROGATE_CHARS.test(input)) {
    return {
      ok: false,
      message: 'Long-term Memory Item content cannot contain unpaired surrogate code points',
    };
  }
  const value = input
    .normalize('NFC')
    .replace(LONG_TERM_MEMORY_CONTROL_CHARS, ' ')
    .replace(LONG_TERM_MEMORY_ZERO_WIDTH_CHARS, '')
    .trim();
  if (value === '') {
    return { ok: false, message: 'Long-term Memory Item content cannot be empty' };
  }
  if (Array.from(value).length > LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS) {
    return {
      ok: false,
      message: `Long-term Memory Item content must be ${LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS} code points or fewer`,
    };
  }
  return { ok: true, value };
}

/** Validate the stored event bounds without deriving a relative status. */
export function validateMemoryTemporalBounds(
  item: Pick<MemoryItem, 'temporalType' | 'eventStartedAt' | 'eventEndedAt'>,
): void {
  if (!isMemoryTemporalType(item.temporalType)) {
    throw new Error('Memory Item has invalid temporalType');
  }
  if (item.temporalType === 'undated') {
    if (item.eventStartedAt !== null || item.eventEndedAt !== null) {
      throw new Error('Undated Memory Item cannot carry event bounds');
    }
    return;
  }
  const start = item.eventStartedAt;
  if (!isTimestamp(start)) throw new Error('Dated Memory Item has invalid eventStartedAt');
  const end = item.eventEndedAt;
  if (item.temporalType === 'interval' && (!isTimestamp(end) || end <= start)) {
    throw new Error('Interval Memory Item requires an end after its start');
  }
  if (item.temporalType === 'point' && end !== null && (!isTimestamp(end) || end <= start)) {
    throw new Error('Point Memory Item end must be later than its start');
  }
  if (item.temporalType === 'open_ended' && end !== null) {
    throw new Error('Open-ended Memory Item cannot carry eventEndedAt');
  }
}

export function isMemoryItemKind(value: unknown): value is MemoryItemKind {
  return memberOf(MEMORY_ITEM_KINDS, value);
}

export function isMemoryStatementType(value: unknown): value is MemoryStatementType {
  return memberOf(MEMORY_STATEMENT_TYPES, value);
}

export function isMemoryTemporalType(value: unknown): value is MemoryTemporalType {
  return memberOf(MEMORY_TEMPORAL_TYPES, value);
}

export function isMemoryScopeType(value: unknown): value is MemoryScopeType {
  return memberOf(MEMORY_SCOPE_TYPES, value);
}

export function isMemoryLifecycleState(value: unknown): value is MemoryLifecycleState {
  return memberOf(MEMORY_LIFECYCLE_STATES, value);
}

export function isMemoryItemOrigin(value: unknown): value is MemoryItemOrigin {
  return memberOf(MEMORY_ITEM_ORIGINS, value);
}

export function isMemoryKeyType(value: unknown): value is MemoryKeyType {
  return memberOf(MEMORY_KEY_TYPES, value);
}

export function isMemoryKeyOrigin(value: unknown): value is MemoryKeyOrigin {
  return memberOf(MEMORY_KEY_ORIGINS, value);
}

function memberOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

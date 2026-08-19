import { createHash } from 'node:crypto';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

export const EXTERNAL_CONVERSATION_BINDING_LIMIT = 500;
export const EXTERNAL_CONVERSATION_RELEASE_RECEIPT_LIMIT = 64;
export const EXTERNAL_CONVERSATION_RELEASE_RECEIPT_TOTAL_LIMIT =
  EXTERNAL_CONVERSATION_BINDING_LIMIT * EXTERNAL_CONVERSATION_RELEASE_RECEIPT_LIMIT;
export const EXTERNAL_CONVERSATION_RELEASE_RETRY_HORIZON_MS = 7 * 24 * 60 * 60 * 1_000;

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const writerBrand: unique symbol = Symbol('InteractiveExternalConversationAuthorityWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveExternalConversationAuthorityWriter>();
const writerOpeningByLease = new WeakMap<
  object,
  Promise<InteractiveExternalConversationAuthorityWriter>
>();

export interface ExternalConversationBinding {
  readonly sessionId: string;
  readonly updatedAt: number;
}

export type ExternalConversationResolveResult =
  | { readonly kind: 'existing'; readonly binding: ExternalConversationBinding }
  | { readonly kind: 'claimed'; readonly binding: ExternalConversationBinding }
  | { readonly kind: 'limit_reached' };

export interface ExternalConversationAuthority {
  lookup(conversationId: string): Promise<ExternalConversationBinding | undefined>;
  resolve(
    conversationId: string,
    proposedSessionId: string,
  ): Promise<ExternalConversationResolveResult>;
  release(conversationId: string, operationId: string): Promise<{ readonly hadBinding: boolean }>;
  remove(conversationId: string, expectedSessionId: string): Promise<boolean>;
  purgeSession(sessionId: string): Promise<number>;
  /**
   * Every Session that still holds at least one binding. Recovery reads this to
   * retry archive-time purges: a leftover binding row is the durable record of
   * that unfinished work.
   */
  listBoundSessionIds(): Promise<string[]>;
}

export interface InteractiveExternalConversationAuthorityWriter
  extends ExternalConversationAuthority {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  close(): void;
}

export function authenticateInteractiveExternalConversationAuthorityWriter(
  writer: InteractiveExternalConversationAuthorityWriter,
): InteractiveExternalConversationAuthorityWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive external-conversation authority writer',
    );
  }
  return writer;
}

export async function openInteractiveExternalConversationAuthorityForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveExternalConversationAuthorityWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteExternalConversationAuthority | undefined;
    try {
      store = await runWithStorageRootLease(
        lease,
        'interactive',
        'write',
        async (root) => new SqliteExternalConversationAuthority(root),
      );
      await assertStorageRootLease(lease, 'interactive', 'write');
      const recoveredExisting = writerByLease.get(lease);
      if (recoveredExisting) {
        store.close();
        return recoveredExisting;
      }
      const writer = createWriterFacade(lease, store);
      writers.add(writer);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      store?.close();
      throw error;
    }
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: SqliteExternalConversationAuthority,
): InteractiveExternalConversationAuthorityWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError(
          'invalid_lease',
          'External-conversation authority writer is closed',
        ),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const writer: InteractiveExternalConversationAuthorityWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    lookup: (conversationId) => run(() => store.lookup(conversationId)),
    resolve: (conversationId, proposedSessionId) =>
      run(() => store.resolve(conversationId, proposedSessionId)),
    release: (conversationId, operationId) => run(() => store.release(conversationId, operationId)),
    remove: (conversationId, expectedSessionId) =>
      run(() => store.remove(conversationId, expectedSessionId)),
    purgeSession: (sessionId) => run(() => store.purgeSession(sessionId)),
    listBoundSessionIds: () => run(() => store.listBoundSessionIds()),
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
      store.close();
    },
  };
  return Object.freeze(writer);
}

class SqliteExternalConversationAuthority implements ExternalConversationAuthority {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(workspaceRoot);
  }

  async lookup(conversationId: string): Promise<ExternalConversationBinding | undefined> {
    return this.#lease.transaction('read', () =>
      this.#readBinding(digestConversationId(conversationId)),
    );
  }

  async resolve(
    conversationId: string,
    proposedSessionId: string,
  ): Promise<ExternalConversationResolveResult> {
    const conversationDigest = digestConversationId(conversationId);
    assertSafeId(proposedSessionId, 'Session id');
    return this.#lease.transaction('write', () => {
      const existing = this.#readBinding(conversationDigest);
      if (existing) return { kind: 'existing', binding: existing };
      const count = this.#lease.database
        .prepare('SELECT COUNT(*) AS count FROM external_conversation_bindings')
        .get() as { count?: unknown };
      if (
        typeof count.count !== 'number' ||
        !Number.isSafeInteger(count.count) ||
        count.count < 0
      ) {
        throw new Error('Invalid external-conversation binding count');
      }
      if (count.count >= EXTERNAL_CONVERSATION_BINDING_LIMIT) {
        return { kind: 'limit_reached' };
      }
      const updatedAt = Date.now();
      this.#lease.database
        .prepare(`
          INSERT INTO external_conversation_bindings(
            conversation_digest, session_id, updated_at
          ) VALUES (?, ?, ?)
        `)
        .run(conversationDigest, proposedSessionId, updatedAt);
      return {
        kind: 'claimed',
        binding: Object.freeze({ sessionId: proposedSessionId, updatedAt }),
      };
    });
  }

  async release(
    conversationId: string,
    operationId: string,
  ): Promise<{ readonly hadBinding: boolean }> {
    const conversationDigest = digestConversationId(conversationId);
    assertSafeId(operationId, 'External-conversation release operation id');
    return this.#lease.transaction('write', () => {
      const now = Date.now();
      // Exact reset deduplication is guaranteed for this explicit platform
      // retry horizon. Prune only expired receipts; reaching either bound
      // rejects a new reset before it can delete a binding.
      this.#lease.database
        .prepare(`
          DELETE FROM external_conversation_release_receipts
          WHERE committed_at < ?
        `)
        .run(Math.max(0, now - EXTERNAL_CONVERSATION_RELEASE_RETRY_HORIZON_MS));
      const receipt = this.#lease.database
        .prepare(`
          SELECT had_binding AS hadBinding
          FROM external_conversation_release_receipts
          WHERE conversation_digest = ? AND operation_id = ?
        `)
        .get(conversationDigest, operationId) as { hadBinding?: unknown } | undefined;
      if (receipt) return Object.freeze({ hadBinding: decodeBoolean(receipt.hadBinding) });

      const conversationReceiptCount = this.#lease.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM external_conversation_release_receipts
          WHERE conversation_digest = ?
        `)
        .get(conversationDigest) as { count?: unknown };
      const totalReceiptCount = this.#lease.database
        .prepare('SELECT COUNT(*) AS count FROM external_conversation_release_receipts')
        .get() as { count?: unknown };
      const perConversation = decodeCount(
        conversationReceiptCount.count,
        'external-conversation release receipt count',
      );
      const total = decodeCount(
        totalReceiptCount.count,
        'external-conversation release receipt total count',
      );
      if (
        perConversation >= EXTERNAL_CONVERSATION_RELEASE_RECEIPT_LIMIT ||
        total >= EXTERNAL_CONVERSATION_RELEASE_RECEIPT_TOTAL_LIMIT
      ) {
        throw new Error('External-conversation release receipt capacity is full');
      }

      const removed = this.#lease.database
        .prepare('DELETE FROM external_conversation_bindings WHERE conversation_digest = ?')
        .run(conversationDigest).changes;
      const hadBinding = removed === 1;
      if (!hadBinding && removed !== 0) {
        throw new Error('External-conversation release removed multiple bindings');
      }
      this.#lease.database
        .prepare(`
          INSERT INTO external_conversation_release_receipts(
            conversation_digest, operation_id, had_binding, committed_at
          ) VALUES (?, ?, ?, ?)
        `)
        .run(conversationDigest, operationId, hadBinding ? 1 : 0, now);
      return Object.freeze({ hadBinding });
    });
  }

  async remove(conversationId: string, expectedSessionId: string): Promise<boolean> {
    const conversationDigest = digestConversationId(conversationId);
    assertSafeId(expectedSessionId, 'Session id');
    return (
      Number(
        this.#lease.transaction('write', () =>
          this.#lease.database
            .prepare(`
            DELETE FROM external_conversation_bindings
            WHERE conversation_digest = ? AND session_id = ?
          `)
            .run(conversationDigest, expectedSessionId),
        ).changes,
      ) === 1
    );
  }

  async purgeSession(sessionId: string): Promise<number> {
    assertSafeId(sessionId, 'Session id');
    return Number(
      this.#lease.transaction(
        'write',
        () =>
          this.#lease.database
            .prepare('DELETE FROM external_conversation_bindings WHERE session_id = ?')
            .run(sessionId).changes,
      ),
    );
  }

  async listBoundSessionIds(): Promise<string[]> {
    const rows = this.#lease.database
      .prepare(
        'SELECT DISTINCT session_id AS sessionId FROM external_conversation_bindings ORDER BY session_id',
      )
      .all() as { sessionId?: unknown }[];
    return rows.map((row) => {
      if (typeof row.sessionId !== 'string') {
        throw new Error('External conversation binding carries an invalid Session id');
      }
      return row.sessionId;
    });
  }

  close(): void {
    this.#lease.close();
  }

  #readBinding(conversationDigest: string): ExternalConversationBinding | undefined {
    const row = this.#lease.database
      .prepare(`
        SELECT session_id AS sessionId, updated_at AS updatedAt
        FROM external_conversation_bindings
        WHERE conversation_digest = ?
      `)
      .get(conversationDigest) as { sessionId?: unknown; updatedAt?: unknown } | undefined;
    if (!row) return undefined;
    if (
      typeof row.sessionId !== 'string' ||
      !SAFE_ID_PATTERN.test(row.sessionId) ||
      typeof row.updatedAt !== 'number' ||
      !Number.isSafeInteger(row.updatedAt) ||
      row.updatedAt < 0
    ) {
      throw new Error('Invalid external-conversation binding');
    }
    return Object.freeze({ sessionId: row.sessionId, updatedAt: row.updatedAt });
  }
}

function decodeCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function digestConversationId(conversationId: string): string {
  if (
    typeof conversationId !== 'string' ||
    conversationId.length === 0 ||
    Buffer.byteLength(conversationId, 'utf8') > 4 * 1024
  ) {
    throw new Error('Invalid external-conversation identity');
  }
  return `sha256:${createHash('sha256').update(conversationId, 'utf8').digest('hex')}`;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function decodeBoolean(value: unknown): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error('Invalid external-conversation release receipt');
}

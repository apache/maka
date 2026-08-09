import type {
  ExternalConversationAuthority,
  ExternalConversationResolveResult,
} from '@maka/storage/external-conversation-authority';
import type {
  ExternalConversationReconcileInput,
  OperationOutcome,
  SessionCatalogItem,
  SessionCreateInput,
} from '../protocol/index.js';
import type { ExternalConversationOperationHandlerMap } from './operation-dispatcher.js';

const RESOLUTION_ATTEMPTS = 4;

type SessionPort = {
  get(sessionId: string): Promise<SessionCatalogItem | null>;
  create(input: SessionCreateInput): Promise<OperationOutcome<'session.create'>>;
};

export interface HostExternalConversationCoordinatorOptions {
  readonly authority: ExternalConversationAuthority;
  readonly sessions: SessionPort;
  readonly newId: () => string;
  readonly requestDrain: () => void;
}

/** Host-owned binding lifecycle for opaque external conversation identities. */
export class HostExternalConversationCoordinator {
  readonly handlers: ExternalConversationOperationHandlerMap = {
    'external-conversation.reconcile': (input) => this.reconcile(input),
  };

  readonly #authority: ExternalConversationAuthority;
  readonly #sessions: SessionPort;
  readonly #newId: () => string;
  readonly #requestDrain: () => void;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: HostExternalConversationCoordinatorOptions) {
    this.#authority = options.authority;
    this.#sessions = options.sessions;
    this.#newId = options.newId;
    this.#requestDrain = options.requestDrain;
  }

  reconcile(
    input: ExternalConversationReconcileInput,
  ): Promise<OperationOutcome<'external-conversation.reconcile'>> {
    return this.#runExclusive(input.conversationId, () =>
      input.kind === 'release' ? this.#release(input) : this.#resolve(input),
    );
  }

  async #release(
    input: Extract<ExternalConversationReconcileInput, { readonly kind: 'release' }>,
  ): Promise<OperationOutcome<'external-conversation.reconcile'>> {
    try {
      const result = await this.#authority.release(input.conversationId, input.operationId);
      return { ok: true, result: { kind: 'released', hadBinding: result.hadBinding } };
    } catch {
      return failure('persistence_failed', 'External conversation could not be released');
    }
  }

  async #resolve(
    input: Extract<ExternalConversationReconcileInput, { readonly kind: 'resolve' }>,
  ): Promise<OperationOutcome<'external-conversation.reconcile'>> {
    for (let attempt = 0; attempt < RESOLUTION_ATTEMPTS; attempt += 1) {
      let binding: ExternalConversationResolveResult;
      try {
        binding = await this.#authority.resolve(input.conversationId, this.#newId());
      } catch {
        return failure('persistence_failed', 'External conversation binding is unavailable');
      }
      if (binding.kind === 'limit_reached') {
        return failure('operation_conflict', 'External conversation binding capacity is full');
      }
      const sessionId = binding.binding.sessionId;
      let existing: SessionCatalogItem | null;
      try {
        existing = await this.#sessions.get(sessionId);
      } catch {
        return failure('persistence_failed', 'Bound Session state is unavailable');
      }
      if (existing && !isRetired(existing)) return resolved(existing);
      if (existing) {
        try {
          await this.#authority.remove(input.conversationId, sessionId);
        } catch {
          return failure('persistence_failed', 'Retired external conversation binding remains');
        }
        continue;
      }

      const created = await this.#sessions.create({ sessionId, ...input.session });
      if (!created.ok) {
        if (created.error.code === 'commit_outcome_unknown') this.#requestDrain();
        return { ok: false, error: created.error };
      }
      return resolved(created.result);
    }
    return failure(
      'operation_conflict',
      'External conversation binding changed repeatedly during resolution',
    );
  }

  async #runExclusive<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(conversationId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(conversationId) === tail) this.#tails.delete(conversationId);
    }
  }
}

function isRetired(session: SessionCatalogItem): boolean {
  return 'kind' in session || session.isArchived || session.status === 'archived';
}

function resolved(
  session: SessionCatalogItem,
): OperationOutcome<'external-conversation.reconcile'> {
  return { ok: true, result: { kind: 'resolved', session } };
}

function failure(
  code: Extract<
    OperationOutcome<'external-conversation.reconcile'>,
    { readonly ok: false }
  >['error']['code'],
  message: string,
): OperationOutcome<'external-conversation.reconcile'> {
  return { ok: false, error: { code, message } };
}

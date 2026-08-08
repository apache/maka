import type { StoredMessage } from './session.js';

/** Stable identifier for one external Agent integration, for example `codex`. */
export type ExternalAgentId = string;

export interface ExternalSessionQuery {
  cwd?: string;
  includeArchived?: boolean;
}

/** Lightweight source-native identity used by session pickers and import commands. */
export interface ExternalSessionSummary {
  id: string;
  name: string;
  cwd: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
}

/**
 * An external session after its source-specific format has been converted to
 * Maka's existing raw Session representation.
 *
 * There is intentionally no intermediate external-message model here. Each
 * adapter owns its source format and emits canonical Maka StoredMessages.
 */
export interface ExternalMakaSession {
  sourceSessionId: string;
  metadata: {
    name: string;
    cwd: string;
  };
  messages: readonly StoredMessage[];
}

/** Read-only, source-specific conversion boundary for one external Agent. */
export interface ExternalSessionAdapter {
  readonly id: ExternalAgentId;

  detect(): Promise<boolean>;

  listSessions(query?: ExternalSessionQuery): Promise<readonly ExternalSessionSummary[]>;

  readSession(sessionId: string): Promise<ExternalMakaSession>;
}

export class ExternalSessionAdapterRegistry {
  private readonly adapters = new Map<ExternalAgentId, ExternalSessionAdapter>();

  constructor(adapters: readonly ExternalSessionAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ExternalSessionAdapter): void {
    if (adapter.id.trim().length === 0) {
      throw new Error('External Session adapter id must not be empty');
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`External Session adapter is already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: ExternalAgentId): ExternalSessionAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  require(adapterId: ExternalAgentId): ExternalSessionAdapter {
    const adapter = this.get(adapterId);
    if (!adapter) throw new Error(`External Session adapter is not registered: ${adapterId}`);
    return adapter;
  }

  list(): readonly ExternalSessionAdapter[] {
    return [...this.adapters.values()];
  }
}

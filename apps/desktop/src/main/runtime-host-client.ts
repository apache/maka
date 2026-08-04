import { decodeStoredMessageForRead, type StoredMessage } from '@maka/core/session';
import {
  connectOrSpawnRuntimeHost,
  type ConnectOrSpawnRuntimeHostResult,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';

export type DesktopRuntimeHostConnectResult =
  | { kind: 'connected'; client: DesktopRuntimeHostClient }
  | Exclude<ConnectOrSpawnRuntimeHostResult, { kind: 'connected' }>;

export interface DesktopRuntimeHostSession {
  readonly snapshot: SessionContinuitySnapshot;
  readonly transcript: Promise<StoredMessage[]>;
  readonly events: AsyncIterable<SubscriptionFrame>;
  close(): Promise<void>;
}

export async function connectDesktopRuntimeHost(
  rootPath: string,
): Promise<DesktopRuntimeHostConnectResult> {
  const result = await connectOrSpawnRuntimeHost({
    rootPath,
    surface: 'desktop',
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  });
  return result.kind === 'connected'
    ? { kind: 'connected', client: new DesktopRuntimeHostClient(result.connection) }
    : result;
}

export class DesktopRuntimeHostClient {
  readonly #sessions = new Set<DesktopSessionHandle>();
  #closeTask: Promise<void> | undefined;

  constructor(private readonly connection: RuntimeHostConnection) {}

  async openSession(sessionId: string): Promise<DesktopRuntimeHostSession> {
    if (this.#closeTask) throw new Error('Desktop Runtime Host Client is closed');
    const subscription = await this.connection.openSessionSubscription({ sessionId });
    if (this.#closeTask) {
      await subscription.close().catch(() => undefined);
      throw new Error('Desktop Runtime Host Client is closed');
    }
    const session = new DesktopSessionHandle(subscription, () => this.#sessions.delete(session));
    this.#sessions.add(session);
    return session;
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    try {
      await Promise.all([...this.#sessions].map((session) => session.close()));
    } finally {
      await this.connection.close();
    }
  }
}

class DesktopSessionHandle implements DesktopRuntimeHostSession {
  readonly snapshot: SessionContinuitySnapshot;
  readonly transcript: Promise<StoredMessage[]>;
  readonly events: AsyncIterable<SubscriptionFrame>;
  #closeTask: Promise<void> | undefined;

  constructor(
    private readonly subscription: RuntimeHostSessionSubscription,
    private readonly onClose: () => void,
  ) {
    this.snapshot = subscription.snapshot;
    this.events = subscription;
    this.transcript = subscription.loadTranscript(decodeStoredMessageForRead);
    void this.transcript.catch(() => undefined);
  }

  close(): Promise<void> {
    this.#closeTask ??= this.subscription.close().finally(this.onClose);
    return this.#closeTask;
  }
}

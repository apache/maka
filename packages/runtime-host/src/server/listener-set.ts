import { startLocalIpcRuntimeHostListener } from './local-ipc-listener.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';
import type { RuntimeHostConnectionAuthority } from './connection-authority.js';

export interface RuntimeHostListenerConnection {
  readonly transport: RuntimeHostMessageTransport;
  readonly authority: RuntimeHostConnectionAuthority;
}

export interface RuntimeHostListener {
  readonly kind: RuntimeHostListenerKind;
  readonly endpoint: string;
  closeAdmission(): Promise<void>;
  cleanup(): Promise<void>;
}

export type RuntimeHostListenerKind = 'local_ipc' | 'websocket';

export interface RuntimeHostListenerSet {
  readonly listeners: readonly RuntimeHostListener[];
  readonly localEndpoint: string;
  closeAdmission(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface RuntimeHostListenerSetFactoryInput {
  readonly rootId: string;
  readonly hostEpoch: string;
  readonly accept: (connection: RuntimeHostListenerConnection) => void;
}

export type RuntimeHostListenerSetFactory = (
  input: RuntimeHostListenerSetFactoryInput,
) => Promise<RuntimeHostListenerSet>;

export async function startLocalRuntimeHostListenerSet(
  input: RuntimeHostListenerSetFactoryInput,
): Promise<RuntimeHostListenerSet> {
  const local = await startLocalIpcRuntimeHostListener(input);
  return createRuntimeHostListenerSet(local);
}

export function createRuntimeHostListenerSet(
  local: RuntimeHostListener & { readonly kind: 'local_ipc' },
  additional: readonly RuntimeHostListener[] = [],
): RuntimeHostListenerSet {
  const listeners = Object.freeze([local, ...additional]);
  return {
    listeners,
    localEndpoint: local.endpoint,
    closeAdmission: () => settleListeners(listeners, (listener) => listener.closeAdmission()),
    cleanup: () => settleListeners([...listeners].reverse(), (listener) => listener.cleanup()),
  };
}

async function settleListeners(
  listeners: readonly RuntimeHostListener[],
  operation: (listener: RuntimeHostListener) => Promise<void>,
): Promise<void> {
  const outcomes = await Promise.allSettled(listeners.map(operation));
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Runtime Host listener set operation failed');
  }
}

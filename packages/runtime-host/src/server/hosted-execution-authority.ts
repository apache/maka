import type { BackendStopMode } from '@maka/core/backend-types';
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import type { MessageContent, SessionEvent } from '@maka/core/events';
import type { UserMessageInput } from '@maka/core/runtime-inputs';
import type { TurnSnapshot } from '../protocol/index.js';

export interface HostedExecutionRef {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export interface HostedExecutionAdmission extends HostedExecutionRef {
  readonly userMessageId: string | null;
  readonly execution: RootExecutionDescriptor;
  readonly content: MessageContent | null;
  readonly turnOrchestration?: UserMessageInput['turnOrchestration'];
  readonly admitExecution?: () => Promise<'executing' | 'cancelled'>;
  readonly start: (input: {
    readonly runId: string;
    readonly userMessageId: string | null;
    readonly onRunStarted: () => void | Promise<void>;
  }) => AsyncIterable<SessionEvent>;
  readonly onEvent?: (event: SessionEvent) => void;
  readonly onReady?: () => void | Promise<void>;
}

export type HostedExecutionSnapshot = TurnSnapshot;

export interface HostedExecutionIdentity extends HostedExecutionRef {
  readonly userMessageId: string | null;
  readonly descriptor: RootExecutionDescriptor;
}

export type HostedExecutionCompletion =
  | {
      readonly kind: 'terminal';
      readonly snapshot: HostedExecutionSnapshot;
    }
  | {
      readonly kind: 'authority_error';
      readonly execution: HostedExecutionRef;
      readonly reason: string;
    };

export interface HostedExecutionObservation extends HostedExecutionRef {
  readonly descriptor: RootExecutionDescriptor;
}

export type HostedExecutionCompletionObserver = (
  completion: HostedExecutionCompletion,
) => void | Promise<void>;

export interface HostedExecutionAdmissionResult {
  readonly snapshot: HostedExecutionSnapshot;
  readonly completion: Promise<HostedExecutionCompletion>;
  readonly settled: Promise<void>;
}

export interface HostedExecutionObserver {
  begin(input: HostedExecutionObservation): HostedExecutionCompletionObserver | undefined;
}

export interface HostedExecutionStopInput {
  readonly execution: HostedExecutionRef;
  readonly source?: 'stop_button' | 'graph_supervisor';
  readonly mode?: BackendStopMode;
}

export type HostedExecutionListener = (execution: HostedExecutionRef) => void;

export interface HostedExecutionPreparedAdmission {
  readonly sessionId: string;
  admit(input: HostedExecutionAdmission): Promise<HostedExecutionAdmissionResult>;
  release(): void;
}

export type HostedExecutionPreparation =
  | {
      readonly kind: 'prepared';
      readonly admission: HostedExecutionPreparedAdmission;
    }
  | {
      readonly kind: 'busy';
      readonly whenIdle: Promise<void>;
      readonly execution?: HostedExecutionRef;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface HostedExecutionAuthority {
  prepare(sessionId: string): HostedExecutionPreparation;
  admit(input: HostedExecutionAdmission): Promise<HostedExecutionAdmissionResult>;
  lookup(sessionId: string, turnId: string): Promise<HostedExecutionIdentity | undefined>;
  read(execution: HostedExecutionRef): Promise<HostedExecutionSnapshot>;
  requestStop(input: HostedExecutionStopInput): Promise<HostedExecutionSnapshot>;
  reconcile(execution: HostedExecutionRef): Promise<HostedExecutionSnapshot>;
  subscribe(listener: HostedExecutionListener): () => void;
  /** Same-Epoch availability hint. Durable reconciliation must not depend on this promise. */
  whenIdle(sessionId: string): Promise<void> | undefined;
  runExclusiveSessionOperation<T>(
    input: {
      readonly sessionId: string;
      readonly abortSignal: AbortSignal;
      readonly stopSource?: HostedExecutionStopInput['source'];
    },
    operation: () => Promise<T>,
  ): Promise<T>;
}

export function isHostedExecutionTerminal(snapshot: HostedExecutionSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

export function completedHostedExecutionAdmission(
  snapshot: HostedExecutionSnapshot,
): HostedExecutionAdmissionResult {
  return Object.freeze({
    snapshot,
    completion: Promise.resolve<HostedExecutionCompletion>({
      kind: 'terminal',
      snapshot,
    }),
    settled: Promise.resolve(),
  });
}

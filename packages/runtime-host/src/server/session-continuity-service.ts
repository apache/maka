import type { SubscriptionFrame } from '../protocol/index.js';
import type { SessionContinuityOperationHandlerMap } from './operation-dispatcher.js';

export interface SessionContinuityFrameSink {
  send(frame: SubscriptionFrame): Promise<void>;
}

export interface SessionContinuityConnection {
  activate(subscriptionId: string): void;
  abort(subscriptionId: string): void;
  close(): void;
}

export interface SessionContinuityService {
  readonly handlers: SessionContinuityOperationHandlerMap;
  attachConnection(
    connectionId: string,
    sink: SessionContinuityFrameSink,
  ): SessionContinuityConnection;
}

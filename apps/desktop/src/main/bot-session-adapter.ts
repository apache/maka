export interface BotSessionResolveInput {
  readonly conversationId: string;
  readonly name: string;
  readonly labels: readonly string[];
}

export type BotSessionResolution =
  | { readonly kind: 'ready'; readonly sessionId: string }
  | { readonly kind: 'permission_refused' };

export type BotSessionTurnResult =
  | { readonly kind: 'completed'; readonly text: string }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'errored'; readonly reason: string }
  | { readonly kind: 'admission_required' };

export interface BotSessionAdapter {
  resolveSession(input: BotSessionResolveInput): Promise<BotSessionResolution>;
  releaseConversation(input: {
    readonly conversationId: string;
    readonly operationId: string;
  }): Promise<boolean>;
  runTurn(input: {
    readonly sessionId: string;
    readonly messageId: string;
    readonly text: string;
    readonly admissionMode?: 'allow' | 'replay_only';
    /**
     * Best-effort projection of the latest assistant text for this Turn.
     *
     * Snapshots may replace previously observed text, so consumers must not
     * treat them as append-only deltas. The callback is synchronous by design:
     * a slow delivery channel must enqueue its own work instead of applying
     * backpressure to the Runtime Host subscription.
     */
    readonly onReplySnapshot?: (text: string) => void;
  }): Promise<BotSessionTurnResult>;
}

interface ParkedRequest<TValue, TMetadata> {
  metadata: TMetadata;
  resolve(value: TValue): void;
  reject(error: Error): void;
}

/**
 * Pure turn-scoped ownership for requests that park tool execution while a
 * host waits for user input. Product policy stays with the owning caller.
 */
export class TurnScopedAwaitRegistry<TValue, TMetadata> {
  private readonly turns = new Map<string, Map<string, ParkedRequest<TValue, TMetadata>>>();

  beginTurn(turnId: string): void {
    if (!this.turns.has(turnId)) this.turns.set(turnId, new Map());
  }

  park(turnId: string, requestId: string, metadata: TMetadata): Promise<TValue> {
    const requests = this.requireTurn(turnId);
    if (requests.has(requestId)) throw new Error(`Request ${requestId} is already parked`);
    return new Promise<TValue>((resolve, reject) => {
      requests.set(requestId, { metadata, resolve, reject });
    });
  }

  resolve(turnId: string, requestId: string, value: TValue): TMetadata | null {
    return this.resolveWith(turnId, requestId, () => value);
  }

  resolveWith(
    turnId: string,
    requestId: string,
    valueFor: (metadata: TMetadata) => TValue,
  ): TMetadata | null {
    const request = this.take(turnId, requestId);
    if (!request) return null;
    request.resolve(valueFor(request.metadata));
    return request.metadata;
  }

  reject(turnId: string, requestId: string, error: Error): TMetadata | null {
    const request = this.take(turnId, requestId);
    if (!request) return null;
    request.reject(error);
    return request.metadata;
  }

  endTurn(turnId: string, errorFor: (requestId: string, metadata: TMetadata) => Error): void {
    const requests = this.turns.get(turnId);
    if (!requests) return;
    this.turns.delete(turnId);
    for (const [requestId, request] of requests) {
      request.reject(errorFor(requestId, request.metadata));
    }
  }

  entries(turnId: string): ReadonlyArray<readonly [string, TMetadata]> {
    return [...(this.turns.get(turnId) ?? [])].map(
      ([requestId, request]) => [requestId, request.metadata] as const,
    );
  }

  findTurn(requestId: string): string | undefined {
    for (const [turnId, requests] of this.turns) {
      if (requests.has(requestId)) return turnId;
    }
    return undefined;
  }

  pendingCount(turnId: string): number {
    return this.turns.get(turnId)?.size ?? 0;
  }

  private take(turnId: string, requestId: string): ParkedRequest<TValue, TMetadata> | null {
    const requests = this.turns.get(turnId);
    const request = requests?.get(requestId);
    if (!request) return null;
    requests?.delete(requestId);
    return request;
  }

  private requireTurn(turnId: string): Map<string, ParkedRequest<TValue, TMetadata>> {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`Turn ${turnId} is not accepting requests`);
    return turn;
  }
}

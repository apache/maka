interface ParkedRequest<TValue, TMetadata> {
  metadata: TMetadata;
  resolve(value: TValue): void;
  reject(error: Error): void;
}

/**
 * Pure ownership for requests that park tool execution while a host waits for
 * user input. Product policy stays with the owning caller.
 *
 * One registry serves one turn, because its owner (ToolRuntime) does: the turn
 * is fixed at construction, so a request id alone identifies a parked request.
 * `close()` is terminal — a request cannot park into a turn that already ended.
 */
export class AwaitRegistry<TValue, TMetadata> {
  private requests: Map<string, ParkedRequest<TValue, TMetadata>> | null = new Map();

  park(requestId: string, metadata: TMetadata): Promise<TValue> {
    const requests = this.requests;
    if (!requests) throw new Error('This turn is not accepting requests');
    if (requests.has(requestId)) throw new Error(`Request ${requestId} is already parked`);
    return new Promise<TValue>((resolve, reject) => {
      requests.set(requestId, { metadata, resolve, reject });
    });
  }

  resolve(requestId: string, value: TValue): TMetadata | null {
    return this.resolveWith(requestId, () => value);
  }

  resolveWith(requestId: string, valueFor: (metadata: TMetadata) => TValue): TMetadata | null {
    const request = this.take(requestId);
    if (!request) return null;
    request.resolve(valueFor(request.metadata));
    return request.metadata;
  }

  reject(requestId: string, error: Error): TMetadata | null {
    const request = this.take(requestId);
    if (!request) return null;
    request.reject(error);
    return request.metadata;
  }

  /** Reject everything still parked and refuse further parks. Idempotent. */
  close(errorFor: (requestId: string, metadata: TMetadata) => Error): void {
    const requests = this.requests;
    if (!requests) return;
    this.requests = null;
    for (const [requestId, request] of requests) {
      request.reject(errorFor(requestId, request.metadata));
    }
  }

  entries(): ReadonlyArray<readonly [string, TMetadata]> {
    return [...(this.requests ?? [])].map(
      ([requestId, request]) => [requestId, request.metadata] as const,
    );
  }

  has(requestId: string): boolean {
    return this.requests?.has(requestId) ?? false;
  }

  pendingCount(): number {
    return this.requests?.size ?? 0;
  }

  private take(requestId: string): ParkedRequest<TValue, TMetadata> | null {
    const request = this.requests?.get(requestId);
    if (!request) return null;
    this.requests?.delete(requestId);
    return request;
  }
}

export interface SessionPresenceReader {
  probeSessionRemoval(
    sessionId: string,
  ): Promise<{ readonly kind: 'present' | 'removed' | 'absent' }>;
}

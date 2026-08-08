import { requireCount, requireExactRecord, requireId } from './codec.js';

export interface SessionCatalogChangedFrame {
  readonly kind: 'session.catalog.changed';
  readonly revision: number;
  readonly sessionId: string;
}

export function decodeSessionCatalogChangedFrame(value: unknown): SessionCatalogChangedFrame {
  const frame = requireExactRecord(value, 'Session catalog changed frame', [
    'kind',
    'revision',
    'sessionId',
  ]);
  return {
    kind: 'session.catalog.changed',
    revision: requireCount(frame.revision, 'Session catalog change revision'),
    sessionId: requireId(frame.sessionId, 'sessionId'),
  };
}

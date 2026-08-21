import { isSessionStatus, type SessionStatus } from '@maka/core/session';
import { invalidProtocolFrame } from './errors.js';

/**
 * Accept status values written by legacy Runtime Hosts without expanding the
 * current wire status shape. This is decode-only compatibility: all outgoing
 * values remain current SessionStatus values.
 */
export function decodeSessionStatus(value: unknown): SessionStatus {
  const normalized = value === 'review' || value === 'done' ? 'active' : value;
  if (!isSessionStatus(normalized)) throw invalidProtocolFrame('Invalid Session status');
  return normalized;
}

import type { DesktopTranscriptBatch } from './transcript-contract.js';

/**
 * Durable transcript sequence identity: the Session's generation and the
 * Runtime Host epoch that produced it.
 *
 * The renderer keeps this alongside the open handle so range requests always
 * carry the epoch of the Host the renderer currently accepts batches from.
 * A replacement Host sends a reset batch with a new generation and epoch;
 * adopting that identity lets the next range request pass the Main-process
 * guard, while requests already dispatched with the previous epoch still fail
 * closed on the old Host.
 */
export interface DesktopTranscriptIdentity {
  readonly generation: string;
  readonly hostEpoch: string;
}

/**
 * Adopts a batch's identity when none is tracked yet or when the batch is a
 * reset; otherwise keeps the current identity. Returns the current identity
 * by reference when nothing changed so callers can detect adoption.
 */
export function adoptTranscriptIdentity(
  current: DesktopTranscriptIdentity | undefined,
  batch: DesktopTranscriptBatch,
): DesktopTranscriptIdentity {
  if (current !== undefined && !batch.reset) return current;
  return { generation: batch.generation, hostEpoch: batch.hostEpoch };
}

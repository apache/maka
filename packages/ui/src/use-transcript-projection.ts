import { useRef } from 'react';
import type { TurnViewModel } from './materialize.js';
import {
  createTranscriptProjection,
  type TranscriptProjection,
  type TranscriptProjectionInput,
} from './transcript-projection.js';

/**
 * Render-time access to the session's incremental transcript projection.
 *
 * Projecting during render (rather than in an effect) keeps the turns the
 * component renders and the turns the projection last produced the same object
 * graph — an effect would publish them a commit late and reintroduce the very
 * re-derivation this replaces. It is safe under React's double-invocation
 * because `project` is idempotent: identical inputs return the identical
 * turns array without advancing any owned state.
 */
export function useTranscriptProjection(
  input: TranscriptProjectionInput,
): readonly TurnViewModel[] {
  const projection = useRef<TranscriptProjection>(undefined);
  projection.current ??= createTranscriptProjection();
  return projection.current.project(input);
}

import type { ArtifactRecord } from '@maka/core/artifacts';

import type { ArtifactStore } from './artifact-store.js';

export interface PersistProviderRequestCaptureArtifactInput {
  sessionId: string;
  turnId: string;
  captureId: string;
  step: number;
  serializedRequest: string;
  now?: number;
}

export function persistProviderRequestCaptureArtifact(
  store: Pick<ArtifactStore, 'create'>,
  input: PersistProviderRequestCaptureArtifactInput,
): Promise<ArtifactRecord> {
  return store.create({
    sessionId: input.sessionId,
    turnId: input.turnId,
    name: `provider-request-step-${input.step}-${input.captureId}.json`,
    kind: 'file',
    content: input.serializedRequest,
    mimeType: 'application/json',
    source: 'provider_request_capture',
    summary: `Prepared provider request for step ${input.step}`,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

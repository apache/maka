import { createExternalExecutionBoundary } from '@maka/core/sandbox-boundary';

import { AiSdkBackend, type AiSdkBackendInput } from '../ai-sdk-backend.js';
import {
  createToolResultArchiveCapability,
  type ToolResultArchiveCapability,
  type ToolResultArchiveServices,
} from '../tool-result-archive-capability.js';
import { ToolRuntime, type ToolRuntimeInput } from '../tool-runtime.js';

export const readExternalExecutionBoundary: AiSdkBackendInput['readExecutionBoundary'] = async () =>
  createExternalExecutionBoundary();

type TestAiSdkBackendInput = Omit<AiSdkBackendInput, 'readExecutionBoundary'> &
  Partial<Pick<AiSdkBackendInput, 'readExecutionBoundary'>>;

export function createTestAiSdkBackend(input: TestAiSdkBackendInput): AiSdkBackend {
  return new AiSdkBackend({
    readExecutionBoundary: readExternalExecutionBoundary,
    ...input,
  });
}

/**
 * An archive capability for tests whose subject is the writer or the replay
 * reader. The unexercised halves resolve to `not_found` rather than being
 * absent: a test may leave a road untravelled, but the capability itself is
 * still whole, which is the invariant these fixtures used to be able to break.
 */
export function testToolResultArchive(
  services: Partial<ToolResultArchiveServices>,
): ToolResultArchiveCapability {
  return createToolResultArchiveCapability({
    archiveToolResult: async () => undefined,
    readToolResultArchive: async () => ({ ok: false, reason: 'not_found' }),
    readArchivedToolResultResource: async () => ({ ok: false, reason: 'not_found' }),
    ...services,
  });
}

type TestToolRuntimeInput = Omit<ToolRuntimeInput, 'readExecutionBoundary' | 'turnId'> &
  Partial<Pick<ToolRuntimeInput, 'readExecutionBoundary' | 'turnId'>>;

/** Defaults to the turn id nearly every ToolRuntime test already uses. */
export function createTestToolRuntime(input: TestToolRuntimeInput): ToolRuntime {
  return new ToolRuntime({
    readExecutionBoundary: readExternalExecutionBoundary,
    turnId: 'turn-1',
    ...input,
  });
}

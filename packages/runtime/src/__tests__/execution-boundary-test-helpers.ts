import { createExternalExecutionBoundary } from '@maka/core';

import { AiSdkBackend, type AiSdkBackendInput } from '../ai-sdk-backend.js';
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

type TestToolRuntimeInput = Omit<ToolRuntimeInput, 'readExecutionBoundary'> &
  Partial<Pick<ToolRuntimeInput, 'readExecutionBoundary'>>;

export function createTestToolRuntime(input: TestToolRuntimeInput): ToolRuntime {
  return new ToolRuntime({
    readExecutionBoundary: readExternalExecutionBoundary,
    ...input,
  });
}

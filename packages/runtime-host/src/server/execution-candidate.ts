import {
  startInteractiveRuntimeHostCandidate,
  type InteractiveRuntimeHostCandidateOptions,
  type InteractiveRuntimeHostCandidateResult,
} from './candidate.js';
import {
  createExecutionRuntimeHostCompositionSource,
  type ExecutionRuntimeHostCompositionDependencies,
} from './execution-composition-factory.js';

export type ExecutionRuntimeHostCandidateResult = InteractiveRuntimeHostCandidateResult;

export type ExecutionRuntimeHostCandidateOptions = InteractiveRuntimeHostCandidateOptions;

export type ExecutionRuntimeHostCandidateDependencies = ExecutionRuntimeHostCompositionDependencies;

export async function startExecutionRuntimeHostCandidate(
  options: ExecutionRuntimeHostCandidateOptions,
  dependencies: ExecutionRuntimeHostCandidateDependencies = {},
): Promise<ExecutionRuntimeHostCandidateResult> {
  const composition = await createExecutionRuntimeHostCompositionSource({}, dependencies);
  return startInteractiveRuntimeHostCandidate(options, composition);
}

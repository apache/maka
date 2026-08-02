import type { TaskRunInspectDocument } from '@maka/headless';
import type { AgentRunInspectDocument, SessionInspectDocument } from '@maka/runtime';

export const INSPECT_RESOLUTION_SCHEMA_VERSION = 'maka.inspect_resolution.v1' as const;

export type InspectEntityKind = 'session' | 'agent-run' | 'task-run';

export type InspectCandidate =
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'agent-run'; readonly id: string; readonly sessionId: string }
  | { readonly kind: 'task-run'; readonly id: string };

export type InspectCandidateDescriptor = InspectCandidate;

export interface InspectResolutionQuery {
  readonly id: string;
  readonly requestedKind?: InspectEntityKind;
  readonly sessionId?: string;
}

export interface InspectResolutionDocument {
  readonly schemaVersion: typeof INSPECT_RESOLUTION_SCHEMA_VERSION;
  readonly kind: 'inspect_resolution';
  readonly query: InspectResolutionQuery;
  readonly status: 'not_found' | 'ambiguous';
  readonly candidates: readonly InspectCandidateDescriptor[];
  readonly candidatesTruncated?: boolean;
}

export type InspectDocument =
  | SessionInspectDocument
  | AgentRunInspectDocument
  | TaskRunInspectDocument;

export type InspectResolution =
  | { readonly status: 'resolved'; readonly candidate: InspectCandidate }
  | {
      readonly status: 'not_found' | 'ambiguous';
      readonly document: InspectResolutionDocument;
    };

export interface InspectCommandBackend {
  resolve(query: InspectResolutionQuery): Promise<InspectResolution>;
  inspect(candidate: InspectCandidate): Promise<InspectDocument>;
}

export function inspectResolutionFailure(
  query: InspectResolutionQuery,
  status: 'not_found' | 'ambiguous',
  candidates: readonly InspectCandidateDescriptor[],
  truncated = false,
): Extract<InspectResolution, { status: 'not_found' | 'ambiguous' }> {
  return {
    status,
    document: {
      schemaVersion: INSPECT_RESOLUTION_SCHEMA_VERSION,
      kind: 'inspect_resolution',
      query: {
        id: query.id,
        ...(query.requestedKind ? { requestedKind: query.requestedKind } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      },
      status,
      candidates: [...candidates],
      ...(truncated ? { candidatesTruncated: true } : {}),
    },
  };
}

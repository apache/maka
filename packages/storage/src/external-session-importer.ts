import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import type { SessionHeader } from '@maka/core/session';
import type { ExternalAgentId, ExternalSessionAdapterRegistry } from '@maka/core/external-session';
import type { SessionAuthorityStore } from './session-store.js';

export type ExternalSessionImportTarget = Omit<CreateSessionInput, 'cwd' | 'name'> & {
  cwd?: string;
  name?: string;
};

export interface ExternalSessionImportRequest {
  adapterId: ExternalAgentId;
  sourceSessionId: string;
  target: ExternalSessionImportTarget;
}

/**
 * Converts no formats itself. The selected adapter returns Maka StoredMessages;
 * the importer only chooses target Session settings and commits them atomically.
 */
export class ExternalSessionImporter {
  constructor(
    private readonly adapters: ExternalSessionAdapterRegistry,
    private readonly sessions: Pick<SessionAuthorityStore, 'createImportedSession'>,
  ) {}

  async import(request: ExternalSessionImportRequest): Promise<SessionHeader> {
    const adapter = this.adapters.require(request.adapterId);
    const external = await adapter.readSession(request.sourceSessionId);

    return this.sessions.createImportedSession(
      {
        ...request.target,
        cwd: request.target.cwd ?? external.metadata.cwd,
        name: request.target.name ?? external.metadata.name,
      },
      external.messages,
    );
  }
}

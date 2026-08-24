/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
      {
        adapterId: request.adapterId,
        sourceSessionId: request.sourceSessionId,
      },
    );
  }
}

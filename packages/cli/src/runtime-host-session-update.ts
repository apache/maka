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

import type { DirectRequestOperationKey, RuntimeHostConnection } from '@maka/runtime-host/client';
import type {
  SessionCatalogItem,
  SessionCatalogProjection,
  SessionUpdateResult,
} from '@maka/runtime-host/protocol';

const MAX_UPDATE_ATTEMPTS = 3;

type RuntimeHostSessionUpdateErrorReason =
  | 'invalid_projection'
  | 'not_found'
  | 'unsupported_session_projection'
  | 'revision_conflict';

export class RuntimeHostSessionUpdateError extends Error {
  readonly name = 'RuntimeHostSessionUpdateError';

  constructor(
    readonly operation: DirectRequestOperationKey,
    readonly reason: RuntimeHostSessionUpdateErrorReason,
    readonly sessionId: string,
    readonly attempts?: number,
  ) {
    super(`Runtime Host Session update failed: ${reason}`);
  }
}

type RuntimeHostSessionUpdateConnection = Pick<RuntimeHostConnection, 'request'>;

export async function getRuntimeHostSession(
  connection: RuntimeHostSessionUpdateConnection,
  sessionId: string,
): Promise<SessionCatalogProjection | null> {
  const result = await connection.request('session.catalog.query', { kind: 'get', sessionId });
  if (result.kind !== 'session') {
    throw new RuntimeHostSessionUpdateError(
      'session.catalog.query',
      'invalid_projection',
      sessionId,
    );
  }
  return result.session === null
    ? null
    : requireRuntimeHostSessionProjection(result.session, 'session.catalog.query');
}

export async function updateRuntimeHostSession(
  connection: RuntimeHostSessionUpdateConnection,
  sessionId: string,
  update: (current: SessionCatalogProjection) => Promise<SessionUpdateResult>,
  options: {
    readonly operation: DirectRequestOperationKey;
    readonly assertRequestAllowed?: () => void;
  },
): Promise<SessionCatalogProjection> {
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    options.assertRequestAllowed?.();
    const current = await getRuntimeHostSession(connection, sessionId);
    if (!current) {
      throw new RuntimeHostSessionUpdateError('session.catalog.query', 'not_found', sessionId);
    }
    options.assertRequestAllowed?.();
    const result = await update(current);
    if (result.kind === 'committed') {
      return requireRuntimeHostSessionProjection(result.session, options.operation);
    }
  }
  throw new RuntimeHostSessionUpdateError(
    options.operation,
    'revision_conflict',
    sessionId,
    MAX_UPDATE_ATTEMPTS,
  );
}

export function requireRuntimeHostSessionProjection(
  session: SessionCatalogItem,
  operation: DirectRequestOperationKey = 'session.catalog.query',
): SessionCatalogProjection {
  if (!('kind' in session)) return session;
  throw new RuntimeHostSessionUpdateError(operation, 'unsupported_session_projection', session.id);
}

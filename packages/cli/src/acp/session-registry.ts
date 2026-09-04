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

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import {
  RequestError,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type NewSessionResponse,
} from '@agentclientprotocol/sdk';
import {
  readRuntimeHostSessionCatalogPage,
  RuntimeHostCatalogReadError,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  RuntimeHostSessionCatalogRevisionChangedError,
  type RuntimeHostConnection,
  type RuntimeHostSessionCatalogPageCursor,
} from '@maka/runtime-host/client';
import {
  SESSION_CATALOG_CURSOR_MAX_BYTES,
  SESSION_CATALOG_CWD_MAX_BYTES,
} from '@maka/runtime-host/protocol';

const ACP_SESSION_CURSOR_MAX_BYTES = 8 * 1024;

type AcpSessionRegistryOperation = 'session.create' | 'session.catalog.query';
type AcpSessionRegistryLifecycleOperation = 'connect' | AcpSessionRegistryOperation;

export interface AcpSessionRegistryConnection {
  readonly request: RuntimeHostConnection['request'];
  close(): Promise<void>;
}

export interface AcpSessionRegistryOptions {
  readonly connect: (signal: AbortSignal) => Promise<AcpSessionRegistryConnection>;
  readonly newSessionId?: () => string;
}

/** Owns all Runtime Host resources associated with one ACP connection. */
export class AcpSessionRegistry {
  readonly #connect: (signal: AbortSignal) => Promise<AcpSessionRegistryConnection>;
  readonly #newSessionId: () => string;
  readonly #inFlightOperations = new Set<Promise<unknown>>();
  #connection: AcpSessionRegistryConnection | undefined;
  #connectTask: Promise<AcpSessionRegistryConnection> | undefined;
  #connectAbortController: AbortController | undefined;
  #closing = false;
  #connectionCloseTask: Promise<void> | undefined;
  #disposeTask: Promise<void> | undefined;

  constructor(options: AcpSessionRegistryOptions) {
    this.#connect = options.connect;
    this.#newSessionId = options.newSessionId ?? randomUUID;
  }

  async create(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.#assertOpen('session.create');
    validateNewSessionParams(params);
    return this.#track(this.#create(params));
  }

  async list(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.#assertOpen('session.catalog.query');
    return this.#track(this.#list(params));
  }

  dispose(): Promise<void> {
    this.#closing = true;
    this.#connectAbortController?.abort();
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #create(params: NewSessionRequest): Promise<NewSessionResponse> {
    const connection = await this.#getConnection('session.create');
    const sessionId = this.#newSessionId();
    try {
      await connection.request('session.create', {
        sessionId,
        workspace: { kind: 'host_path', path: params.cwd },
        modelTarget: { kind: 'default' },
      });
    } catch (error) {
      throw requestErrorFromRuntimeHost(error, 'session.create', { sessionId });
    }
    return { sessionId };
  }

  async #list(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cursor = params.cursor == null ? undefined : decodeAcpSessionCursor(params.cursor);
    const requestedCwd = params.cwd == null ? undefined : await normalizeCwd(params.cwd);
    if (cursor && requestedCwd !== undefined && cursor.cwd !== requestedCwd) {
      throw RequestError.invalidParams(
        { reason: 'cursor_cwd_mismatch' },
        'cursor was created for a different cwd filter',
      );
    }
    const cwd = requestedCwd ?? cursor?.cwd ?? null;
    const connection = await this.#getConnection('session.catalog.query');
    let page;
    try {
      page = await readRuntimeHostSessionCatalogPage(
        connection,
        cursor ? { revision: cursor.revision, cursor: cursor.cursor } : undefined,
      );
    } catch (error) {
      if (error instanceof RuntimeHostSessionCatalogRevisionChangedError) {
        throw RequestError.invalidParams(
          { reason: 'stale_cursor' },
          'session catalog changed; restart listing from the first page',
        );
      }
      throw requestErrorFromRuntimeHost(error, 'session.catalog.query');
    }

    const sessions = page.sessions.flatMap((session) => {
      if ('kind' in session || (cwd !== null && session.workspace.hostCwd !== cwd)) return [];
      const updatedAt = isoTimestamp(session.activityAt);
      return [
        {
          sessionId: session.id,
          cwd: session.workspace.hostCwd,
          title: session.name,
          ...(updatedAt ? { updatedAt } : {}),
        },
      ];
    });
    return {
      sessions,
      ...(page.nextCursor
        ? { nextCursor: encodeAcpSessionCursor({ ...page.nextCursor, cwd }) }
        : {}),
    };
  }

  async #dispose(): Promise<void> {
    const connectionClose = this.#closeOwnedConnection();
    await Promise.allSettled([connectionClose]);
    await Promise.allSettled([...this.#inFlightOperations]);
  }

  #closeOwnedConnection(): Promise<void> {
    const connection = this.#connection;
    const connectTask = this.#connectTask;
    if (!connection && !connectTask) return Promise.resolve();
    this.#connectionCloseTask ??= connection
      ? Promise.resolve().then(() => connection.close())
      : connectTask!.then(
          (connected) => connected.close(),
          () => undefined,
        );
    return this.#connectionCloseTask;
  }

  async #getConnection(
    operation: AcpSessionRegistryOperation,
  ): Promise<AcpSessionRegistryConnection> {
    this.#assertOpen(operation);
    if (this.#connection) return this.#connection;
    let connectController = this.#connectAbortController;
    if (!this.#connectTask) {
      connectController = new AbortController();
      this.#connectAbortController = connectController;
      this.#connectTask = Promise.resolve().then(() => {
        if (this.#closing) throw registryClosedError('connect');
        connectController!.signal.throwIfAborted();
        return this.#connect(connectController!.signal);
      });
    }
    const connectTask = this.#connectTask;
    let connection: AcpSessionRegistryConnection;
    try {
      connection = await connectTask;
    } catch {
      if (this.#connectTask === connectTask) this.#connectTask = undefined;
      if (this.#connectAbortController === connectController) {
        this.#connectAbortController = undefined;
      }
      if (this.#closing) throw registryClosedError('connect');
      throw RequestError.internalError(
        {
          source: 'runtime_host',
          operation: 'connect',
          code: 'connection_failed',
        },
        'Runtime Host connection failed',
      );
    }
    if (this.#connectAbortController === connectController) {
      this.#connectAbortController = undefined;
    }
    if (this.#closing) {
      await this.#closeOwnedConnection().catch(() => undefined);
      throw registryClosedError('connect');
    }
    this.#connection ??= connection;
    return this.#connection;
  }

  async #track<T>(operation: Promise<T>): Promise<T> {
    this.#inFlightOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.#inFlightOperations.delete(operation);
    }
  }

  #assertOpen(operation: AcpSessionRegistryOperation): void {
    if (!this.#closing) return;
    throw registryClosedError(operation);
  }
}

function registryClosedError(operation: AcpSessionRegistryLifecycleOperation): RequestError {
  return RequestError.internalError(
    { source: 'runtime_host', operation, code: 'registry_closed' },
    'ACP session registry is closed',
  );
}

function validateNewSessionParams(params: NewSessionRequest): void {
  assertBoundedAbsoluteCwd(params.cwd);
  if (params.mcpServers.length > 0) {
    throw RequestError.invalidParams(
      { field: 'mcpServers', reason: 'unsupported' },
      'MCP servers are not supported by this ACP adapter yet',
    );
  }
  if ((params.additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams(
      { field: 'additionalDirectories', reason: 'unsupported' },
      'Additional directories are not supported by this ACP adapter yet',
    );
  }
}

function requestErrorFromRuntimeHost(
  error: unknown,
  operation: AcpSessionRegistryOperation,
  extra: Record<string, unknown> = {},
): RequestError {
  const data = { ...runtimeHostErrorData(error, operation), ...extra };
  if (error instanceof RuntimeHostOperationError && error.code === 'invalid_request') {
    return RequestError.invalidParams(data, 'Runtime Host rejected the request');
  }
  return RequestError.internalError(data, 'Runtime Host request failed');
}

function runtimeHostErrorData(error: unknown, operation: string): Record<string, unknown> {
  if (error instanceof RuntimeHostOperationError) {
    return {
      source: 'runtime_host',
      operation: error.operation,
      code: error.code,
    };
  }
  if (error instanceof RuntimeHostRequestInterruptedError) {
    return {
      source: 'runtime_host',
      operation: error.operation,
      code: 'request_interrupted',
      reason: error.reason,
      dispatch: error.dispatch,
    };
  }
  if (error instanceof RuntimeHostCatalogReadError) {
    return {
      source: 'runtime_host',
      operation,
      code: 'catalog_read_failure',
      reason: error.reason,
    };
  }
  return { source: 'runtime_host', operation, code: 'internal_failure' };
}

interface AcpSessionCursor extends RuntimeHostSessionCatalogPageCursor {
  readonly cwd: string | null;
}

function encodeAcpSessionCursor(
  cursor: RuntimeHostSessionCatalogPageCursor & { readonly cwd: string | null },
): string {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > ACP_SESSION_CURSOR_MAX_BYTES) {
    throw RequestError.internalError(
      {
        source: 'runtime_host',
        operation: 'session.catalog.query',
        code: 'cursor_too_large',
      },
      'Runtime Host cursor cannot be represented safely in ACP',
    );
  }
  return encoded;
}

function decodeAcpSessionCursor(encoded: string): AcpSessionCursor {
  try {
    if (encoded.length === 0 || Buffer.byteLength(encoded, 'utf8') > ACP_SESSION_CURSOR_MAX_BYTES) {
      throw new Error('cursor size is invalid');
    }
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error('cursor encoding is invalid');
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('cursor body is invalid');
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      typeof record.revision !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(record.revision) ||
      typeof record.cursor !== 'string' ||
      record.cursor.length === 0 ||
      Buffer.byteLength(record.cursor, 'utf8') > SESSION_CATALOG_CURSOR_MAX_BYTES ||
      !validCursorCwd(record.cwd)
    ) {
      throw new Error('cursor fields are invalid');
    }
    return {
      revision: record.revision as RuntimeHostSessionCatalogPageCursor['revision'],
      cursor: record.cursor,
      cwd: record.cwd,
    };
  } catch {
    throw RequestError.invalidParams({ reason: 'invalid_cursor' }, 'cursor is invalid');
  }
}

function validCursorCwd(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      isAbsolute(value) &&
      normalize(value) === value &&
      Buffer.byteLength(value, 'utf8') <= SESSION_CATALOG_CWD_MAX_BYTES)
  );
}

async function normalizeCwd(cwd: string): Promise<string> {
  assertBoundedAbsoluteCwd(cwd);
  const lexical = normalize(cwd);
  try {
    return await realpath(lexical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return lexical;
    throw RequestError.internalError(
      {
        source: 'filesystem',
        operation: 'cwd.realpath',
        code: code ?? 'internal_failure',
      },
      'cwd could not be canonicalized',
    );
  }
}

function assertBoundedAbsoluteCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw RequestError.invalidParams(
      { field: 'cwd', reason: 'must_be_absolute' },
      'cwd must be an absolute path',
    );
  }
  if (Buffer.byteLength(cwd, 'utf8') > SESSION_CATALOG_CWD_MAX_BYTES) {
    throw RequestError.invalidParams(
      { field: 'cwd', reason: 'too_large' },
      'cwd exceeds the Runtime Host path limit',
    );
  }
}

function isoTimestamp(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

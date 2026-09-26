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

import type { ClientContext, ClientWorkspace } from '@maka-agent/plugin-sdk/client';
import type { Executions, ModelChoices, SessionImportReceipt } from '@maka-agent/plugin-sdk/host';

export type Location =
  | { kind: 'codex' | 'claude_code'; root: string }
  | { kind: 'open_code'; database: string };
export type Source = { id: string; name: string; location: Location };
export type Snapshot = { revision: number | null; configuration: { sources: Source[] } };
export type Entry = {
  id: string;
  path: string;
  title: string;
  cwd: string | null;
  updatedAt: number | null;
  archived: boolean;
};
export type Catalog = { entries: Entry[]; next: string | null };
export type Query = {
  cwd: string | null;
  text: string;
  includeArchived: boolean;
  limit: number;
  cursor: string | null;
};
export type Intent = {
  operationId: string;
  selection: { sourceId: string; sourceRevision: number; sessionId: string; path: string };
  workspace: ClientWorkspace['workspace'];
  settings: Parameters<Executions['createRoot']>[0]['settings'];
};
export type Copy = {
  operationId: string;
  sourceId: string;
  sourceName: string;
  sourceSessionId: string;
  title: string;
  records: number;
  receipt: { [K in keyof SessionImportReceipt]: SessionImportReceipt[K] } | null;
};
export type Copies = { copies: Copy[]; next: string | null };
type Request =
  | { kind: 'sources' }
  | {
      kind: 'save_sources';
      expectedRevision: number | null;
      configuration: Snapshot['configuration'];
    }
  | { kind: 'models'; query: { query: string } }
  | { kind: 'catalog'; sourceId: string; revision: number; query: Query }
  | { kind: 'prepare'; request: Intent }
  | { kind: 'deliver' | 'abandon'; operationId: string }
  | { kind: 'copies'; after: string | null }
  | { kind: 'copy'; operationId: string };
type Response =
  | { kind: 'sources'; snapshot: Snapshot }
  | { kind: 'models'; choices: ModelChoices }
  | { kind: 'catalog'; page: Catalog }
  | { kind: 'copy'; copy: Copy }
  | { kind: 'copies'; page: Copies }
  | { kind: 'detail'; copy: Copy | null }
  | { kind: 'conflict' };

export function connect(context: ClientContext) {
  const invoke = context.remote.method<Request, Response>('request');
  return async <K extends Exclude<Response['kind'], 'conflict'>>(
    request: Request,
    expected: K,
  ): Promise<Extract<Response, { kind: K }>> => {
    context.signal.throwIfAborted();
    const response = await invoke(request);
    context.signal.throwIfAborted();
    if (response.kind === 'conflict')
      throw new Error('Import state changed; refresh and retry / 导入状态已变化，请刷新后重试');
    if (response.kind !== expected) throw new Error('Unexpected import response');
    return response as Extract<Response, { kind: K }>;
  };
}
export type Api = ReturnType<typeof connect>;
export function path(source: Source): string {
  return source.location.kind === 'open_code' ? source.location.database : source.location.root;
}

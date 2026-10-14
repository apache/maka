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

import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';

export async function markAssistantBackgroundSessions(
  store: {
    listHeaders(): Promise<{ id: string }[]>;
    readHeaderRecordSnapshot(
      id: string,
    ): Promise<{ header: { labels?: string[] }; revision: number }>;
    updateHeaderVersioned(
      id: string,
      patch: { labels: string[] },
      revision: number,
    ): Promise<unknown>;
  },
  ids: readonly string[],
) {
  const existing = new Set((await store.listHeaders()).map((h) => h.id));
  for (const id of new Set(ids)) {
    if (!existing.has(id)) continue;
    const { header, revision } = await store.readHeaderRecordSnapshot(id);
    if (header.labels?.includes(ASSISTANT_BACKGROUND_SESSION_LABEL)) continue;
    await store.updateHeaderVersioned(
      id,
      {
        labels: [...(header.labels ?? []), ASSISTANT_BACKGROUND_SESSION_LABEL],
      },
      revision,
    );
  }
}

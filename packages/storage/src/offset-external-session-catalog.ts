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

import { createHash } from 'node:crypto';
import {
  ExternalSessionCatalogCursorError,
  type ExternalSessionCatalogPage,
  type ExternalSessionCatalogPageQuery,
  type ExternalSessionQuery,
  type ExternalSessionSummary,
} from '@maka/core/external-session';

/** Hide offset-based source readers behind the adapter catalog-page interface. */
export async function listOffsetExternalSessionCatalogPage(
  query: ExternalSessionCatalogPageQuery,
  list: (query: ExternalSessionQuery) => Promise<readonly ExternalSessionSummary[]>,
): Promise<ExternalSessionCatalogPage> {
  const limit = query.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('Invalid external Session catalog page');
  }
  if (limit === 0) return { items: [], hasMore: false };

  const offset = decodeOffsetCursor(query.cursor, query);
  const { cursor: _cursor, ...filter } = query;
  const fetchLimit = limit === Number.MAX_SAFE_INTEGER ? limit : limit + 1;
  const summaries = await list({ ...filter, offset, limit: fetchLimit });
  const page = summaries.slice(0, limit);
  return {
    items: page.map((summary, index) => ({
      summary,
      nextCursor: encodeOffsetCursor(query, offset + index + 1),
    })),
    hasMore: summaries.length > page.length,
  };
}

function encodeOffsetCursor(query: ExternalSessionCatalogPageQuery, offset: number): string {
  return `o:${externalSessionCatalogQueryHash(query)}:${offset}`;
}

function decodeOffsetCursor(
  cursor: string | undefined,
  query: ExternalSessionCatalogPageQuery,
): number {
  if (cursor === undefined) return 0;
  const parts = cursor.split(':');
  if (
    parts.length !== 3 ||
    parts[0] !== 'o' ||
    parts[1] !== externalSessionCatalogQueryHash(query) ||
    !/^(0|[1-9]\d*)$/.test(parts[2] ?? '')
  ) {
    throw new ExternalSessionCatalogCursorError();
  }
  const offset = Number(parts[2]);
  if (!Number.isSafeInteger(offset)) throw new ExternalSessionCatalogCursorError();
  return offset;
}

export function externalSessionCatalogQueryHash(query: ExternalSessionCatalogPageQuery): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cwd: query.cwd ?? null,
        includeArchived: query.includeArchived ?? false,
        text: query.text ?? null,
      }),
    )
    .digest('base64url')
    .slice(0, 22);
}

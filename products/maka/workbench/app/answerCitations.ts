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

import { messageBytes, type Row } from './history.ts';

export type AnswerSource = {
  key: string;
  title: string;
  url?: string;
  site?: string;
};
export type InlineCitation = {
  source: AnswerSource;
  anchor: NonNullable<Row['citationAnchor']>;
};

export function answerSource(
  row: Pick<Row, 'citation' | 'text' | 'modelPart' | 'runId'>,
  rowId: string,
): AnswerSource | undefined {
  const citation = row.citation;
  if (!citation) return row.text ? { key: rowId, title: row.text } : undefined;
  if (citation.kind === 'document') {
    return {
      key:
        citation.documentIndex != null && row.modelPart
          ? JSON.stringify([
              'document',
              row.runId,
              row.modelPart.stepId,
              row.modelPart.attemptId,
              citation.documentIndex,
            ])
          : rowId,
      title: citation.filename ? `${citation.title} (${citation.filename})` : citation.title,
    };
  }
  const title = citation.title || citation.url;
  const url = URL.parse(citation.url);
  return url?.protocol === 'https:' || url?.protocol === 'http:'
    ? { key: citation.url, title, url: citation.url, site: url.hostname.replace(/^www\./i, '') }
    : { key: citation.url, title };
}

/** Provider ranges count Unicode scalars. TextView anchors count original UTF-8 bytes. */
export function citationOffsets(
  text: string,
  citations: readonly InlineCitation[],
  totalBytes: number | undefined,
) {
  const ranges = new Map<number, InlineCitation[]>();
  const blockEnds: InlineCitation[] = [];
  for (const citation of citations) {
    const a = citation.anchor;
    if (a.kind === 'block_end') blockEnds.push(citation);
    else if (
      Number.isInteger(a.start) &&
      Number.isInteger(a.end) &&
      a.start >= 0 &&
      a.end > a.start
    ) {
      const entries = ranges.get(a.end) ?? [];
      entries.push(citation);
      ranges.set(a.end, entries);
    }
  }
  const markers = new Map<number, Map<string, AnswerSource>>();
  const insert = (at: number, group: InlineCitation[]) => {
    if (!at || !group.length) return;
    const sources = markers.get(at) ?? new Map<string, AnswerSource>();
    for (const { source } of group) sources.set(source.key, source);
    markers.set(at, sources);
  };
  let points = 0;
  let bytes = 0;
  let lastContent = 0;
  for (const ch of text) {
    bytes += messageBytes(ch);
    if (!/\s/u.test(ch)) lastContent = bytes;
    const group = ranges.get(++points);
    if (group) insert(lastContent, group);
  }
  if (totalBytes === undefined || totalBytes === bytes) insert(lastContent, blockEnds);
  return [...markers].flatMap(([byte, sources]) =>
    [...sources.values()].map((source) => ({ byte, source })),
  );
}

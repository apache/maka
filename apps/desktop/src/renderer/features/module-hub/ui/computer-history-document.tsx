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

import { useState } from 'react';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Markdown, type MarkdownComponents } from '@astryxdesign/core/Markdown';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import type { ComputerHistoryDetail } from '@maka/core/computer-history';
import { useUiLocale } from '@maka/ui';
import { Eye, FileCode, FileText } from '@maka/ui/icons';
import { computerHistoryCopy } from './computer-history-copy.js';

// Observed content cannot issue commands or load tracking images while reading.
const OBSERVED_MARKDOWN_COMPONENTS: Partial<MarkdownComponents> = {
  link: ({ children }) => <span>{children}</span>,
  image: ({ alt }) => alt ? <span>{alt}</span> : null,
};

export function ComputerHistoryDocument({ document }: {
  document: NonNullable<ComputerHistoryDetail['document']>;
}) {
  const copy = computerHistoryCopy(useUiLocale());
  const [mode, setMode] = useState('rendered');

  return (
    <section className="computer-history-document" aria-label={copy.document}>
      <div className="computer-history-document-toolbar">
        <span className="computer-history-document-name" title={document.name}><FileText size={15} aria-hidden /><span>{document.name}</span></span>
        <SegmentedControl label={copy.documentMode} size="sm" value={mode} onChange={setMode}>
          <SegmentedControlItem value="rendered" label={copy.rendered} icon={<Eye size={14} aria-hidden />} />
          <SegmentedControlItem value="source" label={copy.sourceCode} icon={<FileCode size={14} aria-hidden />} />
        </SegmentedControl>
      </div>
      {mode === 'rendered' ? (
        <Markdown className="computer-history-document-body" headingLevelStart={3} contentWidth="100%" components={OBSERVED_MARKDOWN_COMPONENTS}>
          {document.body}
        </Markdown>
      ) : (
        <CodeBlock code={document.markdown} language="markdown" hasLineNumbers container="section" width="100%" />
      )}
    </section>
  );
}

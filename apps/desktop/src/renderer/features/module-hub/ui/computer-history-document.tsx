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

import { useRef, useState } from 'react';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Markdown, type MarkdownComponents } from '@astryxdesign/core/Markdown';
import { Popover } from '@astryxdesign/core/Popover';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import type { ComputerHistoryDetail } from '@maka/core/computer-history';
import { IconButton, Text, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { Copy, Eye, FileCode, FileText, FolderOpen, Info } from '@maka/ui/icons';
import { computerHistoryCopy } from './computer-history-copy.js';

// Observed content cannot issue commands or load tracking images while reading.
const OBSERVED_MARKDOWN_COMPONENTS: Partial<MarkdownComponents> = {
  link: ({ children }) => <span>{children}</span>,
  image: ({ alt }) => alt ? <span>{alt}</span> : null,
};

type DocumentAction = 'filename' | 'markdown' | 'reveal';

export function ComputerHistoryDocument({ document, onCopy, onReveal }: {
  document: NonNullable<ComputerHistoryDetail['document']>;
  onCopy(text: string): Promise<void>;
  onReveal(): Promise<void>;
}) {
  const copy = computerHistoryCopy(useUiLocale());
  const [mode, setMode] = useState('rendered');
  const [pending, setPending] = useState<DocumentAction | null>(null);
  const pendingRef = useRef(false);
  const mounted = useMountedRef();
  const toast = useToast();

  async function run(action: DocumentAction) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    try {
      if (action === 'reveal') await onReveal();
      else await onCopy(action === 'filename' ? document.name : document.markdown);
      if (mounted.current && action !== 'reveal') toast.success(action === 'filename' ? copy.filenameCopied : copy.markdownCopied);
    } catch (error) {
      if (mounted.current) toast.error(action === 'reveal' ? copy.revealFailed : copy.copyFailed, error instanceof Error ? error.message : undefined);
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(null);
    }
  }

  return (
    <section className="computer-history-document" aria-label={copy.document}>
      <div className="computer-history-document-toolbar">
        <div className="computer-history-document-name">
          <FileText size={15} aria-hidden /><span>{copy.activitySummary}</span>
        </div>
        <div className="computer-history-document-actions">
          <SegmentedControl label={copy.documentMode} size="sm" value={mode} onChange={setMode}>
            <SegmentedControlItem value="rendered" label={copy.rendered} icon={<Eye size={14} aria-hidden />} />
            <SegmentedControlItem value="source" label={copy.sourceCode} icon={<FileCode size={14} aria-hidden />} />
          </SegmentedControl>
          <div className="computer-history-document-file-actions">
            <Popover label={copy.documentInfo} placement="below" alignment="end" width="min(320px, calc(100vw - 32px))" isModal={false} content={
              <div className="computer-history-document-info">
                <Text type="supporting" color="secondary">{copy.storedFilename}</Text>
                <div className="computer-history-document-filename">
                  <code>{document.name}</code>
                  <IconButton label={copy.copyFilename} tooltip={copy.copyFilename} icon={<Copy size={15} aria-hidden />} variant="ghost" size="sm" isDisabled={pending !== null} isLoading={pending === 'filename'} onClick={() => void run('filename')} />
                </div>
              </div>
            }>
              <span title={copy.documentInfo}><IconButton label={copy.documentInfo} icon={<Info size={15} aria-hidden />} variant="ghost" size="sm" /></span>
            </Popover>
            <IconButton label={copy.copyMarkdown} tooltip={copy.copyMarkdown} icon={<Copy size={15} aria-hidden />} variant="ghost" size="sm" isDisabled={pending !== null} isLoading={pending === 'markdown'} onClick={() => void run('markdown')} />
            <IconButton label={copy.revealInFinder} tooltip={copy.revealInFinder} icon={<FolderOpen size={15} aria-hidden />} variant="ghost" size="sm" isDisabled={pending !== null} isLoading={pending === 'reveal'} onClick={() => void run('reveal')} />
          </div>
        </div>
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

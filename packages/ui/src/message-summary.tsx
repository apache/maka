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

import { useId, useState, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core';
import { Markdown } from './markdown.js';
import { ChevronDown } from './icons.js';
import { assistantChatCopy } from './assistant-chat-copy.js';
import { useUiLocale } from './locale-context.js';

/** Short and legacy messages stay plain; only authored summaries are collapsible. */
export function MessageSummary({ summary, children }: { summary?: string; children: ReactNode }) {
  return summary ? <CollapsibleMessageSummary summary={summary}>{children}</CollapsibleMessageSummary> : <>{children}</>;
}

function CollapsibleMessageSummary({ summary, children }: { summary: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const locale = useUiLocale();
  const labels = assistantChatCopy(locale);
  return (
    <div className="maka-message-summary">
      <div className="maka-message-summary-header">
      <div className="maka-message-summary-preview"><Markdown text={summary} density="compact" /></div>
      <Button
        type="button"
        label={expanded ? labels.collapse : labels.expand}
        variant="ghost"
        size="sm"
        className="maka-message-summary-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </Button>
      </div>
      <div id={bodyId} className="maka-message-summary-body" hidden={!expanded}>{children}</div>
    </div>
  );
}

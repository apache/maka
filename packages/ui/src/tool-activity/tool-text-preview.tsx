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

import { useContext, useEffect, useRef, useSyncExternalStore, type ComponentProps } from 'react';
import { createTranscriptScrollAuthority } from '../transcript-scroll-authority.js';
import { Button } from '@astryxdesign/core';
import { FileText, ICON_SIZE } from '../icons.js';
import { useUiLocale } from '../locale-context.js';
import { redactSecrets } from '../redact.js';
import type { ToolOutputSource } from './tool-result-context.js';
import { ToolResultHostContext } from './tool-result-context.js';
import { getToolActivityCopy } from './copy.js';
import { ToolCodeBlock } from './tool-code-block.js';
import { capLines } from './preview-utils.js';

/** Reading retained output belongs to the host's artifact viewer. */
export function SavedToolOutput(props: {
  source: ToolOutputSource;
  toolName?: string;
  actionIdentity?: string;
}) {
  const copy = getToolActivityCopy(useUiLocale()).detail;
  const host = useContext(ToolResultHostContext);
  return <span title={!host ? copy.unavailable : undefined}><Button variant="secondary" size="sm" label={copy.viewSaved}
    icon={<FileText size={ICON_SIZE.chrome} aria-hidden="true" />}
    isDisabled={!host}
    onClick={(event) => {
      // Pointer activation does not focus buttons in every browser. The host
      // records this element before transferring focus into the viewer.
      event.currentTarget.focus();
      host?.({ title: props.actionIdentity ?? copy.viewSaved, toolName: props.toolName,
        source: props.source });
    }}
  /></span>;
}

/** Full in-memory text in a height-bounded CodeBlock; only structured JSON
 * truncation keeps an escape hatch to a separate viewer. */
export function ToolTextPreview(props: {
  text: string;
  heading?: string;
  actionIdentity?: string;
  truncated?: boolean;
  toolName?: string;
  savedText?: string;
}) {
  const copy = getToolActivityCopy(useUiLocale()).detail;
  const safe = redactSecrets(props.text);
  const capped = capLines(safe, { chars: 120_000 });
  const code = capped.body;
  const previewTruncated = capped.capped > 0 || capped.hiddenChars > 0;
  const needsSavedOutput = props.truncated || previewTruncated;
  return (
    <>
      <ToolCodeBlock code={code} title={props.heading} actionIdentity={props.actionIdentity} />
      {needsSavedOutput && <>
        <p className="maka-tool-output-note">{copy.previewTruncated}</p>
        <SavedToolOutput toolName={props.toolName}
          source={{ kind: 'text', text: props.savedText ?? safe }} actionIdentity={props.actionIdentity} />
      </>}
    </>
  );
}


/** The transcript's scroll owner, scoped to one tool output viewport. */
export function ToolOutputScroller(props: ComponentProps<'pre'>) {
  const { role = 'region', 'aria-label': ariaLabel, tabIndex = 0, ...preProps } = props;
  const ref = useRef<HTMLPreElement>(null);
  const authority = useRef<ReturnType<typeof createTranscriptScrollAuthority> | undefined>(undefined);
  authority.current ??= createTranscriptScrollAuthority({ explicitResume: true });
  const scroll = authority.current;
  const snapshot = useSyncExternalStore(scroll.subscribe, scroll.getSnapshot, scroll.getSnapshot);
  const copy = getToolActivityCopy(useUiLocale());
  useEffect(() => scroll.attach(ref.current), [scroll]);
  useEffect(() => {
    if (scroll.getSnapshot().pinned) scroll.pinToTail();
  }, [props.children, scroll]);
  return <div className="maka-tool-output-scroller">
    <pre {...preProps} ref={ref} role={role} aria-label={ariaLabel ?? copy.detail.outputRegion} tabIndex={tabIndex} />
    {!snapshot.pinned && <Button className="maka-tool-output-jump" variant="ghost" size="sm" label={copy.detail.jumpToBottom}
      onClick={() => scroll.pinToTail()} />}
  </div>;
}

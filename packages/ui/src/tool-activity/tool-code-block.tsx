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

import { useMemo, type ReactNode } from 'react';
import { CodeBlock } from '@astryxdesign/core';
import { AstryxLocaleProvider } from '../astryx-i18n.js';
import { useUiLocale } from '../locale-context.js';
import { getToolActivityCopy } from './copy.js';

/** Quiet code/text well for tool resultDetail. */
export function ToolCodeBlock(props: {
  code: string;
  language?: string;
  title?: string;
  maxHeight?: string | number;
  actionIdentity?: string;
}) {
  const copy = getToolActivityCopy(useUiLocale()).copy;
  const actionIdentity = props.actionIdentity?.trim();
  const scopedOverrides = useMemo(() => actionIdentity ? {
    '@astryx.codeBlock.copyCode': copy.actionAriaLabel(copy.idle, actionIdentity),
    '@astryx.codeBlock.copied': copy.actionAriaLabel(copy.copied, actionIdentity),
  } : undefined, [actionIdentity, copy]);
  if (!props.code) return null;
  const codeBlock = (
    <CodeBlock
      code={props.code}
      language={props.language}
      title={props.title}
      // Absolute, like every other length the type-scale convergence
      // touched. This was `16rem`, which rendered 208px under the old 13px
      // root and would have become 256px once the root went back to the
      // browser default. rem was never expressing "relative to the type
      // size" here — it was a habit that happened to be a density knob.
      maxHeight={props.maxHeight ?? '208px'}
      width="100%"
      // Astryx's `sm` is the supporting tier (12px); `md` is `--text-code-size`,
      // which is the same 0.875rem the product's own `--maka-text-code` well
      // resolves to. A tool detail that shows a diff beside a command surface
      // was rendering the two at 12px and 14px with different leadings — the
      // `sm` pin was the whole cause, so drop it rather than restyle either.
      isWrapped
    />
  );
  return scopedOverrides ? (
    <AstryxLocaleProvider overrides={scopedOverrides}>
      {codeBlock}
    </AstryxLocaleProvider>
  ) : codeBlock;
}

/** Grid 0fr→1fr enter for tool detail (matches group/reasoning motion). */
export function ToolDetailReveal(props: { children: ReactNode }) {
  return (
    <div className="maka-chat-tool-detail">
      <div className="maka-chat-tool-detail-inner">{props.children}</div>
    </div>
  );
}

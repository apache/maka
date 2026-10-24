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

import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { MediaImageDisplay } from './session-media-image.js';
import { svgPreviewSource } from './media-image-source.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useUiLocale } from './locale-context.js';

/** Settled fences only. Parsing waits for viewport proximity and uses the shared bounded cache. */
export default function SvgCodePreview(props: { code: string; autoRender?: boolean }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const anchor = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [requested, setRequested] = useState(props.autoRender !== false);
  const [showSource, setShowSource] = useState(false);
  const [result, setResult] = useState<{ code: string; src?: string }>();
  useEffect(() => {
    if (visible || !anchor.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '300px' });
    observer.observe(anchor.current);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || !requested) return;
    let cancelled = false;
    void svgPreviewSource(props.code).then(src => {
      if (!cancelled) setResult({ code: props.code, src });
    }, () => { if (!cancelled) setResult({ code: props.code }); });
    return () => { cancelled = true; };
  }, [visible, requested, props.code]);
  const settled = result?.code === props.code;
  const src = settled ? result.src : undefined;
  return <div ref={anchor} className="maka-markdown-code" data-kind="svg-preview">
    {!requested && <Button variant="ghost" size="sm" label={copy.svgPreview} onClick={() => setRequested(true)} />}
    {src && <div>
      <Button variant="ghost" size="sm" label={showSource ? copy.svgPreview : copy.svgSource} onClick={() => setShowSource(value => !value)} />
      <a href={src} download="image.svg">{copy.svgDownload}</a>
    </div>}
    {src && !showSource
      ? <MediaImageDisplay src={src} alt="SVG" onError={() => setResult({ code: props.code })} />
      : <CodeBlock code={props.code} language="svg" highlightMode="spans" width="100%" isCollapsible collapsibleThreshold={10} />}
    {visible && settled && !src && <span role="status">{copy.imageLoadFailed}</span>}
  </div>;
}

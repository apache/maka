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
import { Button, IconButton, Spinner, Tooltip } from '@astryxdesign/core';
import { RotateCw, AlertTriangle } from './icons.js';
import { Link } from '@astryxdesign/core/Link';
import { useChatImageResource } from './chat-image-resource.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useUiLocale } from './locale-context.js';

/** Presentation only: Host resolves local addresses and archives; UI receives artifact identities. */
export function SessionMediaImage(props: { src: string; alt: string; inline?: boolean; redacted?: boolean }) {
  return <ImageResource key={props.src} {...props} redacted={props.redacted === true} />;
}
function ImageResource(props: { src: string; redacted: boolean; alt: string; inline?: boolean }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const anchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible || !anchor.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '300px' });
    observer.observe(anchor.current); return () => observer.disconnect();
  }, [visible]);
  const resource = useChatImageResource({ source: props.src, redacted: props.redacted, visible });
  const state = resource.presentation;
  const [openFailed, setOpenFailed] = useState(false);
  const message = state.kind === 'saved_without_preview' ? (openFailed ? copy.imageOpenSavedFailed : copy.imageSavedWithoutPreview)
    : state.kind === 'loading' ? copy.imageLoading
    : state.kind === 'failed' ? state.reason === 'saved_bytes' ? copy.imageLoadFailed : copy.imageArchiveFailure(state.reason)
    : state.kind === 'unavailable' ? {
      attachment: copy.imageUnavailable,
      remote: copy.imageRemoteUnavailable,
      redacted: copy.imageRemoteRedacted,
      unsupported: copy.imageUnsupported,
    }[state.reason] : undefined;
  const actions = <span className="maka-markdown-image-actions">
    {resource.openSaved && <Button variant="ghost" size="sm" label={copy.imageOpenSaved} onClick={() => {
      void resource.openSaved!().then(result => setOpenFailed(!result.ok), () => setOpenFailed(true));
    }} />}
    {resource.retry && <Button variant="ghost" size="sm" label={copy.imageRetry} onClick={resource.retry} />}
    {resource.openSource && <Link href={resource.openSource} isExternalLink type="inherit" hasUnderline>{copy.imageOpen}</Link>}
  </span>;
  return <span ref={anchor} className={`maka-markdown-image-resource ${props.inline ? 'maka-markdown-image-inline' : 'maka-markdown-image-block'}`}
    data-maka-image-state={state.kind === 'failed' ? 'failed' : state.kind === 'ready' ? 'ready' : 'loading'}>
    {message && props.inline && state.kind !== 'saved_without_preview' ? <Tooltip content={message}>
      <span className="maka-markdown-image-placeholder" role="status" aria-label={message}>
        {resource.retry
          ? <IconButton icon={<RotateCw size={14} />} size="sm" label={copy.imageRetry} onClick={resource.retry} />
          : state.kind === 'unavailable'
            ? <AlertTriangle size={14} aria-hidden="true" /> : <Spinner size="sm" shade="subtle" aria-hidden="true" />}
      </span>
    </Tooltip> : message ? <span className="maka-markdown-image-placeholder">
      {props.alt && <span className="maka-markdown-image-caption">{props.alt}</span>}
      <span role="status">{state.kind === 'loading' && <Spinner size="sm" shade="subtle" aria-hidden="true" />} {message}</span>
      {(state.kind === 'failed' || state.kind === 'saved_without_preview') && actions}
    </span> : state.kind === 'ready' && <MediaImageDisplay key={`${state.src}\0${resource.attempt}`} src={state.src} alt={props.alt} onError={resource.onDecodeError} />}
    {state.kind === 'unavailable' && resource.openSource && actions}
  </span>;
}

export function MediaImageDisplay(props: { src: string; alt: string; onError(): void }) {
  return <img src={props.src} alt={props.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
    className="maka-markdown-attachment-image" onError={props.onError} />;
}

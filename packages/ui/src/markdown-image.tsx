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
import { Button, IconButton, Spinner, Tooltip, useLightbox } from '@astryxdesign/core';
import { createMarkdownPlugin, type MarkdownExtensionNode } from '@astryxdesign/core/Markdown/plugins';
import type { MarkdownAstNode, MarkdownAstRoot } from '@astryxdesign/core/Markdown';
import { RotateCw, AlertTriangle } from './icons.js';
import { Link } from '@astryxdesign/core/Link';
import { useChatImageResource } from './chat-image-resource.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { useUiLocale } from './locale-context.js';
import { createMarkdownImageSourceResolver } from './markdown-image-source.js';
import { redactSecrets } from './redact.js';

type PlacedImage = MarkdownExtensionNode<'maka-images', 'image', { src: string; alt: string; inline: boolean; redacted: boolean }>;
// Markdown structure determines inline/block placement; decoded images supply
// their natural dimensions within the presentation's CSS bounds.
export function createMarkdownImagePlugins(
  display: 'image' | 'link' = 'image',
  sources?: ReadonlyMap<string, string>,
) {
  return [createMarkdownPlugin<'maka-images', PlacedImage>({
    name: 'maka-images', apiVersion: 1,
    transform(document, context) {
      if (!context.source.includes('![')) return document;
      const canonical = createMarkdownImageSourceResolver(context.source);
      const rewrite = (node: MarkdownAstNode, inline = false, phrasing = false, insideLink = false): MarkdownAstNode => {
        if (node.type === 'image') {
          const destination = canonical(node.url);
          const source = sources?.get(destination) ?? destination;
          const redacted = source !== redactSecrets(source);
          if (display === 'link') {
            const text = { type: 'text' as const, value: node.alt || redactSecrets(source) };
            const link = insideLink || redacted ? text
              : { type: 'link' as const, url: source, children: [text] };
            return phrasing ? link : { type: 'paragraph', children: [link] };
          }
          return {
            type: 'extension', plugin: 'maka-images', name: 'image',
            display: phrasing ? 'inline' : 'block',
            data: { src: source, alt: node.alt, inline, redacted: sources?.has(destination) === true && redacted },
          } satisfies PlacedImage;
        }
        if (!('children' in node)) return node;
        const childInline = node.type === 'paragraph' ? !isSingleImage(node.children)
          : node.type === 'heading' || node.type === 'tableCell' ? true : inline;
        const childPhrasing = ['paragraph', 'heading', 'tableCell', 'link', 'strong', 'emphasis', 'delete'].includes(node.type);
        return { ...node, children: node.children.map(child => rewrite(child, childInline, childPhrasing, insideLink || node.type === 'link')) } as MarkdownAstNode;
      };
      return rewrite(document) as MarkdownAstRoot<MarkdownExtensionNode>;
    },
    renderers: { image: {
      render: ({ node }) => <MarkdownImage {...node.data} />,
      toText: node => node.data.alt,
    } },
  })];
}

function isSingleImage(nodes: readonly MarkdownAstNode[]): boolean {
  const meaningful = nodes.filter(node => node.type !== 'text' || node.value.trim());
  if (meaningful.length !== 1) return false;
  const node = meaningful[0]!;
  return node.type === 'image' || (['link', 'strong', 'emphasis', 'delete'].includes(node.type)
    && 'children' in node && isSingleImage(node.children));
}
/** Presentation only: Host resolves local addresses and archives; UI receives artifact identities. */
export function MarkdownImage(props: { src: string; alt: string; inline?: boolean; redacted?: boolean }) {
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
  const message = state.kind === 'loading' ? copy.imageLoading
    : state.kind === 'failed' ? state.reason === 'saved_bytes' ? copy.imageLoadFailed : copy.imageArchiveFailure(state.reason)
    : state.kind === 'unavailable' ? {
      attachment: copy.imageUnavailable,
      remote: copy.imageRemoteUnavailable,
      redacted: copy.imageRemoteRedacted,
      unsupported: copy.imageUnsupported,
    }[state.reason] : undefined;
  const actions = <span className="maka-markdown-image-actions">
    {resource.retry && <Button variant="ghost" size="sm" label={copy.imageRetry} onClick={resource.retry} />}
    {resource.openSource && <Link href={resource.openSource} isExternalLink type="inherit" hasUnderline>{copy.imageOpen}</Link>}
  </span>;
  return <span ref={anchor} className={`maka-markdown-image-resource ${props.inline ? 'maka-markdown-image-inline' : 'maka-markdown-image-block'}`}
    data-maka-image-state={state.kind === 'failed' ? 'failed' : state.kind === 'ready' ? 'ready' : 'loading'}>
    {message && props.inline ? <Tooltip content={message}>
      <span className="maka-markdown-image-placeholder" role="status" aria-label={message}>
        {resource.retry
          ? <IconButton icon={<RotateCw size={14} />} size="sm" label={copy.imageRetry} onClick={resource.retry} />
          : state.kind === 'unavailable'
            ? <AlertTriangle size={14} aria-hidden="true" /> : <Spinner size="sm" shade="subtle" aria-hidden="true" />}
      </span>
    </Tooltip> : message ? <span className="maka-markdown-image-placeholder">
      {props.alt && <span className="maka-markdown-image-caption">{props.alt}</span>}
      <span role="status">{state.kind === 'loading' && <Spinner size="sm" shade="subtle" aria-hidden="true" />} {message}</span>
      {state.kind === 'failed' && actions}
    </span> : state.kind === 'ready' && <DisplayImage key={`${state.src}\0${resource.attempt}`} src={state.src} alt={props.alt} onError={resource.onDecodeError} />}
    {state.kind === 'unavailable' && resource.openSource && actions}
  </span>;
}

function DisplayImage(props: { src: string; alt: string; onError(): void }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const [loaded, setLoaded] = useState(false);
  const lightbox = useLightbox({ media: { src: props.src, alt: props.alt }, hasZoom: true });
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (lightbox.isOpen) return () => trigger.current?.focus();
  }, [lightbox.isOpen]);
  const content = <>
    {!loaded && <span className="maka-markdown-image-loading" role="status" aria-label={copy.imageLoading}><Spinner size="sm" shade="subtle" aria-hidden="true" /> <span className="maka-markdown-image-loading-label">{copy.imageLoading}</span></span>}
    <img src={props.src} alt={props.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
        className="maka-markdown-attachment-image" onLoad={() => setLoaded(true)} onError={props.onError} />
  </>;
  return <>
    <Button ref={trigger} variant="ghost" className="maka-markdown-image-preview maka-markdown-image-trigger"
        label={copy.imageExpand(props.alt)} aria-haspopup="dialog" isDisabled={!loaded}
        style={{ padding: 0, background: 'transparent' }}
        onClick={event => { event.preventDefault(); event.stopPropagation(); if (loaded) lightbox.open(); }}>
      {content}
    </Button>
    {lightbox.isOpen && lightbox.element}
  </>;
}

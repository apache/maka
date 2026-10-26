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

import { createMarkdownPlugin, type MarkdownExtensionNode } from '@astryxdesign/core/Markdown/plugins';
import type { MarkdownAstNode, MarkdownAstRoot } from '@astryxdesign/core/Markdown';
import { createMarkdownImageSourceResolver } from './markdown-image-source.js';
import { redactSecrets } from './redact.js';

import { SessionMediaImage as MarkdownImage } from './session-media-image.js';

type PlacedImage = MarkdownExtensionNode<'maka-images', 'image', { src: string; alt: string; inline: boolean; redacted: boolean }>;
// Markdown structure determines inline/block placement; decoded images supply
// their natural dimensions within the presentation's CSS bounds.
export function createMarkdownImagePlugins(
  display: 'image' | 'link' = 'image',
) {
  return [createMarkdownPlugin<'maka-images', PlacedImage>({
    name: 'maka-images', apiVersion: 1,
    transform(document, context) {
      if (!context.source.includes('![')) return document;
      const canonical = createMarkdownImageSourceResolver(context.source);
      const rewrite = (node: MarkdownAstNode, inline = false, phrasing = false, insideLink = false): MarkdownAstNode => {
        if (node.type === 'image') {
          const source = canonical(node.url);
          const redacted = source.includes('<redacted>') || source !== redactSecrets(source);
          if (display === 'link') {
            const text = { type: 'text' as const, value: node.alt || redactSecrets(source) };
            const link = insideLink || redacted ? text
              : { type: 'link' as const, url: source, children: [text] };
            return phrasing ? link : { type: 'paragraph', children: [link] };
          }
          return {
            type: 'extension', plugin: 'maka-images', name: 'image',
            display: phrasing ? 'inline' : 'block',
            data: { src: source, alt: node.alt, inline, redacted },
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
/** Markdown is one adapter to the shared session-media presentation. */
export { SessionMediaImage as MarkdownImage } from './session-media-image.js';

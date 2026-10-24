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

import { parseMarkdownAst, type MarkdownAstNode, type MarkdownAstRoot } from '@astryxdesign/core/Markdown/parser';
import { createMarkdownPlugin, type MarkdownExtensionNode } from '@astryxdesign/core/Markdown/plugins';
import { isStickerArtifactId, parseAttachmentResourceRef, STICKER_ARTIFACT_PREFIX } from '@maka/core/attachments';
import { createMarkdownImageSourceResolver } from './markdown-image-source.js';

/** Move only real sticker image nodes, never code examples or ordinary photos. */
export function separateStickerNodes(document: MarkdownAstRoot<MarkdownExtensionNode>, source: string) {
  const stickers: { src: string; alt: string }[] = [];
  const canonical = createMarkdownImageSourceResolver(source);
  const visit = (node: MarkdownAstNode): MarkdownAstNode | undefined => {
    if (node.type === 'image') {
      const src = canonical(node.url);
      const ref = parseAttachmentResourceRef(src);
      if (ref && isStickerArtifactId(ref.artifactId)) {
        stickers.push({ src, alt: node.alt });
        return undefined;
      }
    }
    if (!('children' in node)) return node;
    const children = node.children.flatMap(child => {
      const next = visit(child);
      return next ? [next] : [];
    });
    if (children.length !== node.children.length && children.every(child => child.type === 'text' && !child.value.trim())) return undefined;
    return { ...node, children } as MarkdownAstNode;
  };
  return { document: (visit(document) ?? { type: 'root', children: [] }) as MarkdownAstRoot<MarkdownExtensionNode>, stickers };
}

export function inspectMessageStickers(source: string) {
  if (!source.includes(STICKER_ARTIFACT_PREFIX)) return undefined;
  const result = separateStickerNodes(parseMarkdownAst(source), source);
  return result.stickers.length ? result : undefined;
}

export const separateStickersPlugin = createMarkdownPlugin({
  name: 'maka-separate-stickers', apiVersion: 1,
  transform: (document, context) => separateStickerNodes(document, context.source).document,
});

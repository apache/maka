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

import { Lexer, Marked } from 'marked';
import { IMAGE_MARKDOWN_MAX_LENGTH } from './image-delivery.js';

const parser = new Marked({ gfm: true });

/** Canonical image destinations in real Markdown nodes, including attachment refs.
 * Consumers own their source policy; parsing grants no filesystem or network access.
 */
export function markdownImageSources(text: string): string[] {
  return [...new Set(markdownImages(text).map((image) => image.source))];
}

/** Original token spelling and canonical destination, including reference images. */
export function markdownImages(text: string): { raw: string; source: string }[] {
  if (!text.includes('![') || text.length > IMAGE_MARKDOWN_MAX_LENGTH) return [];
  const images: { raw: string; source: string }[] = [];
  parser.walkTokens(parser.lexer(text), (token) => {
    if (token.type === 'image') images.push({ raw: token.raw, source: token.href });
  });
  return images;
}

/** Resolve a complete inline destination, rejecting trailing or partial syntax. */
export function parseMarkdownImageDestination(source: string): string | undefined {
  const markdown = `![](${source})`;
  const [token] = Lexer.lexInline(markdown, { gfm: true });
  return token?.type === 'image' && token.raw === markdown ? token.href : undefined;
}

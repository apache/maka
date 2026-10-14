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

import {
  IMAGE_DELIVERY_SOURCE_MAX_LENGTH,
  IMAGE_MARKDOWN_MAX_LENGTH,
} from '@maka/core/image-delivery';
import { markdownImageSources, parseMarkdownImageDestination } from '@maka/core/image-markdown';

/** Astryx can pass destination syntax through its image slot. Resolve it with
 * the Host's Markdown parser, without changing the text rendered or stored.
 * Parse the document lazily, once, only for destinations needing normalization.
 */
export function createMarkdownImageSourceResolver(text: string): (source: string) => string {
  let canonicalSources: Set<string> | undefined;
  return (source) => {
    if (
      !/[<>"'\\\s&]/.test(source) ||
      source.length > IMAGE_DELIVERY_SOURCE_MAX_LENGTH ||
      text.length > IMAGE_MARKDOWN_MAX_LENGTH
    )
      return source;
    canonicalSources ??= new Set(markdownImageSources(text));
    // Reference destinations already arrive without brackets/title syntax.
    // Preserve a canonical path containing literal quotes or whitespace.
    if (canonicalSources.has(source)) return source;
    const destination = parseMarkdownImageDestination(source);
    return destination !== undefined && canonicalSources.has(destination) ? destination : source;
  };
}

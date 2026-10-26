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

import { decideImageReadOutcome } from './artifact-preview-registry.js';
import type { ArtifactBinaryReadResult } from '@maka/core/artifacts';

const svgSources = new Map<string, string>();
let svgChars = 0;
const MAX_SVG_CACHE_CHARS = 1024 * 1024;
export async function svgPreviewSource(text: string): Promise<string> {
  if (text.length > 256 * 1024) throw new Error('SVG exceeds preview limits');
  const cached = svgSources.get(text);
  if (cached) { svgSources.delete(text); svgSources.set(text, cached); return cached; }
  const { prepareSvgPreview } = await import('@maka/core/svg-preview');
  // Another consumer may have populated the cache while the module loaded.
  const ready = svgSources.get(text);
  if (ready) return ready;
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(prepareSvgPreview(text))}`;
  svgSources.set(text, source); svgChars += text.length + source.length;
  while (svgSources.size > 16 || svgChars > MAX_SVG_CACHE_CHARS) {
    const key = svgSources.keys().next().value!;
    svgChars -= key.length + svgSources.get(key)!.length;
    svgSources.delete(key);
  }
  return source;
}

export async function mediaImageSource(result: ArtifactBinaryReadResult): Promise<string | undefined> {
  const outcome = decideImageReadOutcome(result);
  if (outcome.kind !== 'image') return undefined;
  if (outcome.safeMime === 'image/svg+xml') {
    const bytes = Uint8Array.from(atob(outcome.base64), c => c.charCodeAt(0));
    return svgPreviewSource(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  return `data:${outcome.safeMime};base64,${outcome.base64}`;
}

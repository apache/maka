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

import { positionedMarkdownImages } from '@maka/core/image-markdown';
import { redactSecrets } from './redact.js';

/** Preserve resource identities using the canonical parser's exact source ranges.
 * The alias map is presentation-only and never grants source loading. */
export function redactMarkdownImages(text: string, settledText?: string) {
  let prefix = 'maka-image-display:';
  while (text.includes(prefix) || settledText?.includes(prefix)) prefix += 'x';
  const sources = new Map<string, string>();
  const aliases = new Map<string, string>();
  const prepare = (original: string): string => {
    const redacted = redactSecrets(original);
    if (redacted === original) return redacted;
    const images = positionedMarkdownImages(original).filter(image =>
      redactSecrets(image.source) !== image.source || redactSecrets(image.raw) !== image.raw);
    if (!images.length) return redacted;
    const replacements = images.map(image => {
      let alias = aliases.get(image.source);
      if (!alias) {
        alias = `${prefix}${aliases.size}`;
        aliases.set(image.source, alias);
        sources.set(alias, image.source);
      }
      const alt = redactSecrets(image.alt).replace(/[\\[\]`*_<>|]/g, '\\$&');
      return { start: image.start, end: image.end, value: `![${alt}](${alias})` };
    });
    let protectedText = original;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      protectedText = protectedText.slice(0, replacement.start) + replacement.value + protectedText.slice(replacement.end);
    }
    return redactSecrets(protectedText);
  };
  return {
    text: prepare(text),
    settledText: settledText === undefined ? undefined : prepare(settledText),
    sources,
  };
}

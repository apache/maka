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

/**
 * The text a README hero bakes in: the hero header of a built page, without
 * the parts the render hides. The render records it beside the images and the
 * site test recomputes it, so committed heroes cannot outlive their copy.
 */
const hidden =
  /<h1 class="display">.*?<\/h1>|<p class="lede">.*?<\/p>|<div class="cta">.*?<\/div>|<div class="fine">.*?<\/div>/gsu;

const entities = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function heroText(html) {
  const start = html.indexOf('<header class="hero">');
  if (start === -1) throw new Error('no hero header in the page');
  const end = html.indexOf('</header>', start);
  return html
    .slice(start, end)
    .replace(hidden, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&[a-z#0-9]+;/gu, (entity) => entities[entity] ?? entity)
    .replace(/\s+/gu, ' ')
    .trim();
}

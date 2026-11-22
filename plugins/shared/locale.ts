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

/** One message in English, Simplified Chinese and Traditional Chinese. */
export type Message = readonly [en: string, zhCN: string, zhTW: string];
export type Catalog = Readonly<Record<string, Message>>;

/** Explicit product preferences win; auto follows the bound native environment. */
export function resolveLocale(configured: string, native: unknown): string {
  if (configured && configured !== 'auto') return configured;
  return typeof native === 'string' && native.length > 0 ? native : 'en';
}

export function languageIndex(locale: string): 0 | 1 | 2 {
  const tag = locale.toLowerCase();
  return tag.startsWith('zh')
    ? tag.includes('hant') ||
      tag.startsWith('zh-tw') ||
      tag.startsWith('zh-hk') ||
      tag.startsWith('zh-mo')
      ? 2
      : 1
    : 0;
}

/** Build the three immutable feature maps once; rendering only selects a map. */
export function createCopy<C extends Catalog>(messages: C) {
  type Copy = Readonly<{ [K in keyof C]: string }>;
  const entries = Object.entries(messages);
  const catalogs = ([0, 1, 2] as const).map(
    (language) =>
      Object.freeze(
        Object.fromEntries(entries.map(([key, message]) => [key, message[language]])),
      ) as Copy,
  );
  return (locale: string): Copy => catalogs[languageIndex(locale)]!;
}

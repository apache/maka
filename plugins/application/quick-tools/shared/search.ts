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
import { qt } from './i18n.js';
export interface SearchEntry {
  id: string;
  name: string;
  kind?: string;
  keywords?: string;
  description?: string;
}
export interface Preference {
  enabled?: boolean;
  alias?: string;
  source?: { id: string; query: string; page?: string };
  favorite?: boolean;
  uses?: number;
  lastUsed?: number;
}
export type Segment = (text: string) => string[];
const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase().trim();
export const normalizeSearchText = (text: string) =>
  normalize(text)
    .slice(0, 8000)
    .replace(/记一下|记下来|记一笔/g, '笔记');
const stopWords = new Set(['的', '了', '一下', '一个', '这个', '帮我', '请', 'the', 'a', 'an']);
// Small, deterministic vocabulary; model-based intent expansion remains asynchronous.
const synonyms: Record<string, string> = {
  notes: '笔记',
  note: '笔记',
  memo: '笔记',
  记录: '笔记',
  calculator: '计算',
  calculate: '计算',
  计算器: '计算',
  files: '文件',
  file: '文件',
  search: '搜索',
  查找: '搜索',
  寻找: '搜索',
  emoji: '表情',
  emojis: '表情',
  clipboard: '剪贴板',
};
function tokens(text: string, segment: Segment): string[] {
  return segment(normalizeSearchText(text))
    .filter((token) => !stopWords.has(token))
    .map((token) => synonyms[token] ?? token);
}
const fields = ['name', 'alias', 'keywords', 'description'] as const;
const weights = [5, 6, 2, 0.7];
function frequencies(text: string, segment: Segment): Map<string, number> {
  const result = new Map<string, number>();
  for (const token of tokens(text, segment)) result.set(token, (result.get(token) ?? 0) + 1);
  return result;
}
function fuzzyName(name: string, query: string): boolean {
  if (!/^[a-z0-9]{2,32}$/.test(query)) return false;
  let pos = -1;
  for (const char of query) {
    pos = name.indexOf(char, pos + 1);
    if (pos < 0) return false;
  }
  return true;
}
export function searchEntries<T extends SearchEntry>(
  entries: T[],
  query: string,
  prefs: Record<string, Preference>,
  segment: Segment,
): T[] {
  const q = normalize(query).slice(0, 500);
  const usage = (entry: SearchEntry) => {
    const p = prefs[entry.id] ?? {};
    return (
      (p.favorite ? 300 : 0) + Math.min(p.uses ?? 0, 50) + Math.min((p.lastUsed ?? 0) / 1e13, 1)
    );
  };
  if (!q)
    return entries
      .filter((e) => prefs[e.id]?.favorite || prefs[e.id]?.uses || e.kind === 'tool')
      .sort((a, b) => usage(b) - usage(a) || a.name.localeCompare(b.name, 'zh-CN'))
      .slice(0, 80);
  const terms = [...new Set(tokens(q, segment))];
  const documents = entries.map((entry) => {
    const values = {
      name: entry.name,
      alias: prefs[entry.id]?.alias ?? '',
      keywords: entry.keywords ?? '',
      description: entry.description ?? '',
    };
    const counts = fields.map((field) => frequencies(values[field], segment));
    return {
      entry,
      values,
      counts,
      lengths: counts.map((count) => [...count.values()].reduce((a, b) => a + b, 0)),
    };
  });
  const averages = fields.map(
    (_, i) => documents.reduce((sum, d) => sum + d.lengths[i], 0) / Math.max(1, documents.length),
  );
  const idf = new Map(
    terms.map((term) => {
      const df = documents.filter((d) => d.counts.some((c) => c.has(term))).length;
      return [term, Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))];
    }),
  );
  return documents
    .map((d) => {
      const name = normalize(d.values.name),
        alias = normalize(d.values.alias);
      // BM25F: normalize and weight each field before term-frequency saturation.
      let relevance = 0,
        matched = 0;
      for (const term of terms) {
        const tf = d.counts.reduce(
          (sum, count, i) =>
            sum +
            (weights[i] * (count.get(term) ?? 0)) /
              (0.25 + (0.75 * d.lengths[i]) / (averages[i] || 1)),
          0,
        );
        if (tf > 0) {
          matched++;
          relevance += (idf.get(term)! * (tf * 2.2)) / (tf + 1.2);
        }
      }
      // Exact/prefix matching also handles partial typing, symbols, pinyin and aliases.
      const tier =
        alias === q
          ? 6
          : name === q
            ? 5
            : name.startsWith(q) || alias.startsWith(q)
              ? 4
              : name.includes(q) || alias.includes(q)
                ? 3
                : relevance > 0
                  ? 2
                  : normalize(d.values.keywords).includes(q) || fuzzyName(name, q)
                    ? 1
                    : 0;
      return { entry: d.entry, tier, matched, relevance };
    })
    .filter((d) => d.tier > 0)
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        b.matched - a.matched ||
        b.relevance - a.relevance ||
        usage(b.entry) - usage(a.entry) ||
        a.entry.name.localeCompare(b.entry.name, 'zh-CN'),
    )
    .slice(0, 80)
    .map((d) => d.entry);
}
/** Recognise omitted web schemes before parsing parameters, including localhost:port. */
export function linkTarget(input: string): string {
  const target = input.trim();
  if (/^localhost(?=[:/?#]|$)|^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+(?=[:/?#]|$)/iu.test(target))
    return `https://${target}`;
  return target;
}

export function resolveLink(target: string, argument = ''): string {
  const result = linkTarget(target);
  if (/[\x00-\x1f]/.test(result)) throw Error(qt('无效目标'));
  if (/^https?:\/\/([/?#]|$)/i.test(result))
    throw Error(qt('网址缺少域名，请补全为 https://example.com。'));
  if (result.startsWith('/') || result.startsWith('~/')) return result;
  const value = result.replaceAll('{query}', encodeURIComponent(argument));
  try {
    const url = new URL(value);
    if (
      url.protocol === 'file:' &&
      /^file:\/\/\//i.test(value) &&
      !url.host &&
      !url.search &&
      !url.hash
    )
      return decodeURIComponent(url.pathname);
    if (/^https?:\/\/[^/?#\\]/i.test(value) && !value.includes('\\') && url.hostname) return value;
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
      ![
        'http:',
        'https:',
        'file:',
        'javascript:',
        'data:',
        'vbscript:',
        'blob:',
        'about:',
      ].includes(url.protocol)
    )
      return value;
    if (url.protocol === 'mailto:' && url.pathname) return value;
  } catch {}
  throw Error(qt('请输入网站地址、应用深链或本地文件路径'));
}

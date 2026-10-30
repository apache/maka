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

/** Model-facing metadata is bounded; stored originals and identity remain unchanged. */
export function compactTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(title);
  return chars.length > 120 ? chars.slice(0, 119).join('') + '…' : title;
}

export function evidenceMetadata(kind: unknown) {
  if (kind === 'test')
    return {
      evidenceKind: 'test',
      evidenceNotice: '测试或模拟数据，不是用户事实；不能据此推断真实偏好、承诺或待办。',
    };
  if (kind === 'generated')
    return {
      evidenceKind: 'generated',
      evidenceNotice:
        '模型生成的摘要，可能混有测试或模拟内容；不是已核实的用户事实，使用前核对原始来源。',
    };
  return {};
}

/** Identical titles are sent once per page, with an explicit lookup on each item. */
export function compactTitles<T extends { title?: string }>(items: T[]) {
  const counts = new Map<string, number>();
  for (const item of items)
    if (item.title) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
  const titles = [...counts].filter(([, count]) => count > 1).map(([title]) => title);
  const positions = new Map(titles.map((title, i) => [title, i]));
  return {
    items: items.map((item) => {
      const titleIndex = item.title ? positions.get(item.title) : undefined;
      if (titleIndex === undefined) return item;
      const { title, ...rest } = item;
      return { ...rest, titleIndex };
    }),
    ...(titles.length ? { titles } : {}),
  };
}

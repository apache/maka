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

/** Declarative presentation only. No scripts, arbitrary styles or executable actions. */
export interface AssistantCardAction {
  label: string;
  kind: 'link' | 'reply';
  /** A web URL for link; the complete user request submitted by a reply choice. */
  value: string;
}
export interface AssistantCardItem {
  title: string;
  description?: string;
  image?: { url: string; alt: string };
  facts?: { label: string; value: string }[];
  actions?: AssistantCardAction[];
}
export interface AssistantCard {
  type: 'recommendation' | 'offer' | 'delivery';
  title: string;
  description?: string;
  items: AssistantCardItem[];
}
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  return Object.keys(v).every((k) => allowed.includes(k));
}
function text(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}
export function isCardWebUrl(v: unknown): v is string {
  if (!text(v, 2048) || /[\s<>]/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}
export function isAssistantCard(v: unknown): v is AssistantCard {
  if (
    !record(v) ||
    !keys(v, ['type', 'title', 'description', 'items']) ||
    !['recommendation', 'offer', 'delivery'].includes(String(v.type)) ||
    !text(v.title, 120) ||
    (v.description !== undefined && !text(v.description, 600)) ||
    !Array.isArray(v.items) ||
    v.items.length < 1 ||
    v.items.length > 6
  )
    return false;
  return v.items.every(
    (i) =>
      record(i) &&
      keys(i, ['title', 'description', 'image', 'facts', 'actions']) &&
      text(i.title, 120) &&
      (i.description === undefined || text(i.description, 1200)) &&
      (i.image === undefined ||
        (record(i.image) &&
          keys(i.image, ['url', 'alt']) &&
          isCardWebUrl(i.image.url) &&
          text(i.image.alt, 200))) &&
      (i.facts === undefined ||
        (Array.isArray(i.facts) &&
          i.facts.length <= 6 &&
          i.facts.every(
            (f) =>
              record(f) && keys(f, ['label', 'value']) && text(f.label, 40) && text(f.value, 240),
          ))) &&
      (i.actions === undefined ||
        (Array.isArray(i.actions) &&
          i.actions.length <= 3 &&
          i.actions.every(
            (a) =>
              record(a) &&
              keys(a, ['label', 'kind', 'value']) &&
              text(a.label, 40) &&
              (a.kind === 'link'
                ? isCardWebUrl(a.value)
                : a.kind === 'reply' && text(a.value, 2000)),
          ))),
  );
}
/** Text-only channels, recall and model replay retain all useful card content. */
export function assistantCardText(card: AssistantCard): string {
  return [
    card.title,
    card.description,
    ...card.items.flatMap((item) => [
      item.title,
      item.description,
      ...(item.facts ?? []).map((f) => `${f.label}：${f.value}`),
      ...(item.actions ?? []).map((a) => `${a.label}：${a.value}`),
    ]),
  ]
    .filter(Boolean)
    .join('\n');
}
export function assistantMessageText(message: { text: string; card?: AssistantCard }): string {
  return message.card ? `${message.text}\n\n${assistantCardText(message.card)}` : message.text;
}
/** For image admission only, not a grant to fetch. Remote image consent remains required. */
export function assistantCardImageMarkdown(card?: AssistantCard): string {
  return card?.items.flatMap((i) => (i.image ? [`![](<${i.image.url}>)`] : [])).join('\n') ?? '';
}

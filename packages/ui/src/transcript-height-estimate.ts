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

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TurnViewModel } from './materialize.js';

export interface TranscriptHeightProfile {
  width: number;
  font: number;
  line: number;
  gap: number;
  chrome: number;
  userFont: number;
  userLine: number;
  userPadding: number;
  userInset: number;
  code?: { line: number; chrome: number };
}

function wrappedLines(text: string, width: number, font: number): number {
  // Approximate glyph advances, not a second text-layout engine. Real browser
  // measurements replace these values when the row enters the viewport.
  let advance = 0;
  for (const char of text) advance += char.codePointAt(0)! > 255 ? font : font / 2;
  return Math.max(1, Math.ceil(advance / Math.max(font, width)));
}

/** Only plain paragraphs and closed, non-diagram fences have known geometry. */
export function estimateTranscriptText(text: string, profile: TranscriptHeightProfile): number | undefined {
  const blocks: number[] = [];
  let paragraph = '';
  let fence: RegExp | undefined;
  let lines = 0;
  const flush = () => {
    if (paragraph) blocks.push(wrappedLines(paragraph, profile.width, profile.font) * profile.line);
    paragraph = '';
  };
  for (const line of text.split('\n')) {
    if (fence) {
      if (fence.test(line)) {
        if (!profile.code) return undefined;
        blocks.push(Math.max(1, lines) * profile.code.line + profile.code.chrome);
        fence = undefined;
      } else lines++;
      continue;
    }
    const opening = /^(`{3,}|~{3,})([^`]*)$/.exec(line);
    if (opening) {
      if (/mermaid/i.test(opening[2]!)) return undefined;
      flush(); fence = new RegExp(`^${opening[1]![0]}{${opening[1]!.length},}\\s*$`); lines = 0; continue;
    }
    // Lists, headings, images, math, links, tables and nested/indented blocks
    // belong to the renderer. Their unknown size keeps the existing fallback.
    if (/^(?:\s{2,}|\t|#{1,6}\s|>|[-+*]\s|\d+[.)]\s|[-=_]{3,}\s*$)|[<>|$`\[\]*_]|\\[([]| {2,}$|\\$/.test(line)) return undefined;
    if (!line.trim()) flush();
    else paragraph += (paragraph ? ' ' : '') + line;
  }
  if (fence) return undefined;
  flush();
  return blocks.reduce((sum, height) => sum + height, 0) + Math.max(0, blocks.length - 1) * profile.gap;
}

function simpleText(turn: TurnViewModel): string | undefined {
  if (!turn.user || turn.status !== 'completed' || turn.tools.length || turn.notes.length || turn.assistantThinking
    || turn.user.attachments?.length || turn.user.quotes?.length || turn.user.directoryReferences?.length
    || turn.user.inlineReferences?.length || turn.timeline.filter((item) => item.kind === 'user').length > 1
    || turn.timeline.some((item) => item.kind !== 'user' && item.kind !== 'text')) return undefined;
  const text = turn.timeline.filter((item) => item.kind === 'text');
  return text.length === 1 && !text[0]!.live ? text[0]!.text : undefined;
}

/** Samples layout, never mounts hidden content. The geometry ledger owns sizes. */
export function useTranscriptHeightEstimates(
  root: RefObject<HTMLElement | null>, turns: readonly TurnViewModel[], enabled: boolean,
): ReadonlyMap<string, number> {
  const [profile, setProfile] = useState<TranscriptHeightProfile>();
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const hasTurns = turns.length > 0;
  useEffect(() => {
    const list = root.current?.querySelector<HTMLElement>('.maka-chatContent');
    if (!enabled || !list || typeof ResizeObserver === 'undefined') return;
    let sampledWidth = 0;
    let hasCode = false;
    const observer = new ResizeObserver(([entry]) => {
      // Content-height changes are frequent; typography is sampled only while
      // incomplete or after a width change, not once per message or scroll.
      const needsCode = turnsRef.current.some((turn) => /^(?:`{3,}|~{3,})/m.test(simpleText(turn) ?? ''));
      if (sampledWidth === entry.contentRect.width && (!needsCode || hasCode)) return;
      let sample: TranscriptHeightProfile | undefined;
      for (const row of list.querySelectorAll<HTMLElement>('.maka-turn')) {
        const turn = turnsRef.current.find((item) => item.turnId === row.dataset.turnId);
        if (!turn || simpleText(turn) === undefined) continue;
        const md = row.querySelector<HTMLElement>('.astryx-markdown');
        const user = row.querySelector<HTMLElement>('.maka-chat-message-bubble-user');
        if (!md || !user || md.querySelector('img,table,ul,ol,blockquote,h1,h2,h3,h4,h5,h6')) continue;
        const style = getComputedStyle(md), userStyle = getComputedStyle(user);
        const px = (value: string) => Number.parseFloat(value) || 0;
        const next: TranscriptHeightProfile = {
          width: md.getBoundingClientRect().width, font: px(style.fontSize), line: px(style.lineHeight),
          gap: px(style.getPropertyValue('--md-gap-block')),
          chrome: row.getBoundingClientRect().height - md.getBoundingClientRect().height - user.getBoundingClientRect().height,
          userFont: px(userStyle.fontSize), userLine: px(userStyle.lineHeight),
          userPadding: px(userStyle.paddingTop) + px(userStyle.paddingBottom),
          userInset: px(userStyle.paddingLeft) + px(userStyle.paddingRight),
        };
        if (next.width <= 0 || next.line <= 0) continue;
        const code = md.querySelector<HTMLElement>('.astryx-code-block');
        const codeLines = code?.querySelectorAll<HTMLElement>('[data-line]');
        if (code && codeLines?.length) {
          const line = px(getComputedStyle(codeLines[0]!).lineHeight);
          const chrome = code.getBoundingClientRect().height - codeLines.length * line;
          if (line > 0 && chrome >= 0) next.code = { line, chrome };
        }
        sample ??= next;
        if (next.code) { sample = next; break; }
      }
      if (!sample) return;
      sampledWidth = entry.contentRect.width;
      hasCode = sample.code !== undefined;
      setProfile(sample);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [enabled, root, hasTurns]);

  return useMemo(() => {
    const estimates = new Map<string, number>();
    if (!profile) return estimates;
    for (const turn of turns) {
      const text = simpleText(turn);
      if (text === undefined) continue;
      const body = estimateTranscriptText(text, profile);
      if (body === undefined) continue;
      const userLines = (turn.user!.text ?? '').split('\n').reduce((sum, line) =>
        sum + wrappedLines(line, profile.width - profile.userInset, profile.userFont), 0);
      estimates.set(turn.turnId, Math.max(1, profile.chrome + profile.userPadding + userLines * profile.userLine + body));
    }
    return estimates;
  }, [turns, profile]);
}

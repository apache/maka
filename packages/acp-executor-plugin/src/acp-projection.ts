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

import type { ContentBlock, ToolCall, ToolCallContent } from '@agentclientprotocol/sdk';
import type {
  PluginExecutorContext,
  PluginExecutorRequest,
  PluginExecutorToolResultContent,
} from '@maka/runtime/plugin-executor-service';

import {
  type SessionContentPart,
  type SessionMediaInput,
  SESSION_CONTENT_MAX_PARTS,
  SESSION_MEDIA_MAX_BYTES,
  SESSION_MEDIA_MAX_BASE64,
} from '@maka/core/session-media';

const MAX_EVENT_TEXT = 8_192;
const MAX_TOOL_RESULT_DIFF = 1024 * 1024;

export function promptText(request: Readonly<PluginExecutorRequest>): string {
  const sections = [request.text];
  if (request.instructions) sections.push(`Agent instructions:\n${request.instructions}`);
  for (const quote of request.quotes ?? []) sections.push(`Quoted context:\n${quote.text}`);
  for (const reference of request.directoryReferences ?? [])
    sections.push(`Project directory reference: ${reference.path}`);
  return sections.filter(Boolean).join('\n\n');
}

export function emitText(
  context: PluginExecutorContext,
  type: 'output_delta' | 'thinking_delta',
  text: string,
): void {
  const safeText = text.replaceAll('\r', '');
  for (let offset = 0; offset < safeText.length; offset += MAX_EVENT_TEXT) {
    const chunk = safeText.slice(offset, offset + MAX_EVENT_TEXT);
    context.emit({ type, text: chunk });
  }
}

export function emitToolOutput(
  context: PluginExecutorContext,
  toolCallId: string,
  text: string,
): void {
  const safeText = text.replaceAll('\r', '');
  for (let offset = 0; offset < safeText.length; offset += MAX_EVENT_TEXT) {
    context.emit({
      type: 'tool_output_delta',
      toolCallId,
      text: safeText.slice(offset, offset + MAX_EVENT_TEXT),
    });
  }
}

export function projectToolResult(
  content: readonly ToolCallContent[],
  rawOutput: unknown,
): PluginExecutorToolResultContent {
  const diffs = content.flatMap((item) =>
    item.type === 'diff'
      ? [
          {
            path: item.path,
            diff: createWholeFileDiff(item.path, item.oldText ?? '', item.newText ?? ''),
          },
        ]
      : [],
  );
  const combinedDiff = diffs.map(({ diff }) => diff).join('');
  if (diffs.length && diffs.length <= 64 && combinedDiff.length <= MAX_TOOL_RESULT_DIFF)
    return {
      kind: 'file_diff',
      paths: diffs.map(({ path }) => path),
      diff: combinedDiff,
    };
  if (diffs.length)
    return {
      kind: 'text',
      text: boundedText(
        `${diffs.map(({ path }) => `Updated ${path}`).join('\n')}\nDiff omitted because it exceeds the executor event limit.`,
      ),
    };
  return { kind: 'text', text: boundedText(summarizeToolResult(content, rawOutput)) };
}

function createWholeFileDiff(path: string, oldText: string, newText: string): string {
  const oldFile = diffLines(oldText);
  const newFile = diffLines(newText);
  const oldLines = oldFile.lines;
  const newLines = newFile.lines;
  return (
    [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
      ...diffSide(oldLines, '-', oldFile.endsWithNewline),
      ...diffSide(newLines, '+', newFile.endsWithNewline),
    ].join('\n') + '\n'
  );
}

function diffLines(text: string): { lines: string[]; endsWithNewline: boolean } {
  const normalized = text.replaceAll('\r', '');
  if (!normalized) return { lines: [], endsWithNewline: true };
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

function diffSide(lines: readonly string[], prefix: '-' | '+', endsWithNewline: boolean): string[] {
  return lines.flatMap((line, index) => [
    `${prefix}${line}`,
    ...(index === lines.length - 1 && !endsWithNewline ? ['\\ No newline at end of file'] : []),
  ]);
}

export function summarizeToolContent(content: readonly ToolCallContent[]): string {
  return content
    .map((item) => {
      if (item.type === 'diff') return `Updated ${item.path}`;
      if (item.type === 'terminal') return item.terminalId ? `Terminal ${item.terminalId}` : '';
      return item.content.type === 'text' ? item.content.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeToolResult(content: readonly ToolCallContent[], rawOutput: unknown): string {
  const summary = summarizeToolContent(content);
  if (summary) return summary;
  if (rawOutput === undefined) return '';
  try {
    return JSON.stringify(rawOutput);
  } catch {
    return 'External tool completed';
  }
}

export function boundedText(value: string): string {
  const safe = value.replace(/[\0\r]/gu, '');
  return safe.length <= MAX_EVENT_TEXT ? safe : `${safe.slice(0, MAX_EVENT_TEXT - 1)}…`;
}

export function toolName(value: string): string {
  return value.replace(/[\0\r\n]/gu, '').slice(0, 256) || 'external_tool';
}

export function activityKind(kind: ToolCall['kind'] | undefined) {
  if (kind === 'read') return 'read' as const;
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit' as const;
  if (kind === 'search') return 'search' as const;
  if (kind === 'fetch') return 'webfetch' as const;
  if (kind === 'execute') return 'command' as const;
  if (kind === 'think') return 'explore' as const;
  return 'tool' as const;
}

/** Preserve protocol content order; only the Host can publish media bytes or read a source. */
export async function projectContentBlock(
  content: ContentBlock,
  context: PluginExecutorContext,
): Promise<Exclude<SessionContentPart, { kind: 'file_diff' }>> {
  if (content.type === 'text') return { kind: 'text', text: boundedText(content.text) };
  let input: SessionMediaInput | undefined;
  if (content.type === 'image')
    input = { kind: 'inline', mimeType: content.mimeType, base64: content.data };
  if (content.type === 'resource_link') {
    if (
      content.mimeType?.startsWith('image/') ||
      /\.(svg|png|jpe?g|webp|gif)(?:[?#]|$)/i.test(content.uri)
    )
      input = { kind: 'source', source: content.uri };
    else return { kind: 'text', text: boundedText(`${content.name}: ${content.uri}`) };
  }
  if (content.type === 'resource') {
    const resource = content.resource;
    if ('text' in resource) {
      if (resource.mimeType === 'image/svg+xml' || /\.svg(?:[?#]|$)/i.test(resource.uri)) {
        if (resource.text.length > SESSION_MEDIA_MAX_BYTES)
          return { kind: 'text', text: '[Media unavailable: too large]' };
        input = {
          kind: 'inline',
          mimeType: 'image/svg+xml',
          base64: Buffer.from(resource.text).toString('base64'),
        };
      } else return { kind: 'text', text: boundedText(resource.text) };
    } else if (resource.mimeType?.startsWith('image/'))
      input = { kind: 'inline', mimeType: resource.mimeType, base64: resource.blob };
  }
  if (!input || !context.publishMedia) return { kind: 'text', text: '[Media preview unavailable]' };
  if (context.signal.aborted) return { kind: 'text', text: '[Media publication cancelled]' };
  let onAbort!: () => void;
  const cancelled = new Promise<SessionContentPart>((resolve) => {
    onAbort = () => resolve({ kind: 'text', text: '[Media publication cancelled]' });
    context.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // The Host owns archival work. Stop waiting on cancellation, but keep observing late
    // rejection through the race and never let late publication emit another ACP update.
    const part = await Promise.race([context.publishMedia(input), cancelled]);
    return part.kind === 'file_diff' ? { kind: 'text', text: '[Media preview unavailable]' } : part;
  } catch {
    return { kind: 'text', text: '[Media publication failed]' };
  } finally {
    context.signal.removeEventListener('abort', onAbort);
  }
}

export async function projectRichToolResult(
  content: readonly ToolCallContent[],
  rawOutput: unknown,
  context: PluginExecutorContext,
  truncated = false,
): Promise<PluginExecutorToolResultContent> {
  // The queue already discarded the tail. Preserve its omission even when that
  // tail contained the only media and the retained prefix is entirely text/diff.
  if (truncated)
    content = [
      ...content,
      {
        type: 'content',
        content: { type: 'text', text: '[Additional tool content omitted]' },
      },
    ];
  if (
    !truncated &&
    !content.some((item) => item.type === 'content' && item.content.type !== 'text')
  )
    return projectToolResult(content, rawOutput);
  const parts: SessionContentPart[] = [];
  let budget = MAX_TOOL_RESULT_DIFF;
  for (const item of content.slice(0, SESSION_CONTENT_MAX_PARTS)) {
    const part =
      item.type === 'content'
        ? await projectContentBlock(item.content, context)
        : item.type === 'diff'
          ? projectToolResult([item], undefined)
          : { kind: 'text' as const, text: boundedText(`Terminal ${item.terminalId}`) };
    if (part.kind === 'content') continue;
    const normalized: SessionContentPart =
      part.kind === 'file_diff' ? { ...part, paths: [...part.paths] } : part;
    budget -= Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    if (
      budget < 1024 ||
      (parts.length === SESSION_CONTENT_MAX_PARTS - 1 && content.length > SESSION_CONTENT_MAX_PARTS)
    ) {
      parts.push({ kind: 'text', text: '[Additional tool content omitted]' });
      break;
    }
    parts.push(normalized);
  }
  return { kind: 'content', parts };
}

/** Retain only fields used by projection; provider metadata is never queue-owned. */
export function normalizeQueuedContent(block: ContentBlock): ContentBlock {
  const omitted: ContentBlock = {
    type: 'text',
    text: '[Media omitted: response media limit reached]',
  };
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image' || block.type === 'audio') {
    if (block.data.length > SESSION_MEDIA_MAX_BASE64 || block.mimeType.length > 128) return omitted;
    return { type: block.type, data: block.data, mimeType: block.mimeType };
  }
  if (block.type === 'resource_link') {
    if (
      block.uri.length > 4096 ||
      block.name.length > MAX_EVENT_TEXT ||
      (block.mimeType?.length ?? 0) > 128
    )
      return omitted;
    return {
      type: 'resource_link',
      uri: block.uri,
      name: block.name,
      ...(block.mimeType ? { mimeType: block.mimeType } : {}),
    };
  }
  const resource = block.resource;
  if (resource.uri.length > 4096 || (resource.mimeType?.length ?? 0) > 128) return omitted;
  const payload = 'text' in resource ? resource.text : resource.blob;
  if (payload.length > SESSION_MEDIA_MAX_BASE64) return omitted;
  return {
    type: 'resource',
    resource: {
      uri: resource.uri,
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...('text' in resource ? { text: resource.text } : { blob: resource.blob }),
    },
  };
}

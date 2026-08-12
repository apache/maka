import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type MarkdownTheme,
} from '@earendil-works/pi-tui';
import type { ToolResultContent } from '@maka/core/events';
import { projectAgentSwarmResult } from '@maka/core/agent-swarm';
import { ptyHumanTerminalText } from '@maka/core/pty-output-view';
import { type ShellOutput } from '@maka/core/shell-run';
import { ansi } from './tui-ansi.js';

export function renderIndented(text: string, width: number, indent: number): string[] {
  const prefix = ' '.repeat(indent);
  const contentWidth = Math.max(1, width - indent);
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const wrapped = wrapTextWithAnsi(rawLine, contentWidth);
    for (const line of wrapped.length > 0 ? wrapped : ['']) {
      out.push(prefix + line);
    }
  }
  return out;
}

export function fitLine(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, '…') : line;
}

export function formatToolResultContent(content: ToolResultContent): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'json':
      return formatUnknown(content.value);
    case 'terminal':
      return [
        `$ ${content.cmd}`,
        `cwd: ${content.cwd}`,
        `status: ${content.status}`,
        content.exitCode !== undefined ? `exit: ${content.exitCode}` : '',
        formatShellOutput(content.output),
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'shell_run':
      return [
        `$ ${content.cmd}`,
        `cwd: ${content.cwd}`,
        `ref: ${content.ref}`,
        `status: ${content.status}`,
        content.exitCode !== undefined ? `exit: ${content.exitCode}` : '',
        content.output ? formatShellOutput(content.output) : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'file_diff':
      return content.diff;
    case 'file_write':
      return `Wrote ${content.bytes} bytes to ${content.path}`;
    case 'summary':
      return content.summarized;
    case 'image':
      return `${content.mimeType} image result`;
    case 'web_search':
      return [
        `Search ${content.provider}: ${content.query}`,
        ...content.rows.map((row) => `${row.title}\n${row.url}\n${row.snippet}`),
      ].join('\n\n');
    case 'web_search_error':
      return content.message;
    case 'explore_agent':
      return (
        content.report ??
        content.summary ??
        content.message ??
        `Inspected ${content.filesInspected} files`
      );
    case 'subagent':
      return content.summary;
    case 'agent_swarm': {
      const projection = projectAgentSwarmResult(content);
      return limitText(
        [
          [
            `Agent swarm: ${projection.status}`,
            `${projection.itemCount} items`,
            `${projection.completedItemCount} completed`,
            `${projection.failedItemCount} failed`,
            `${projection.cancelledItemCount} cancelled`,
            `${projection.artifactCount} artifacts`,
            `${projection.durationMs}ms`,
          ].join(' · '),
          ...content.items.map((item) =>
            [
              [
                `${item.itemId}: ${item.status}`,
                item.profile,
                item.durationMs !== undefined ? `${item.durationMs}ms` : '',
                `${item.artifactIds.length} artifacts`,
                item.resumedFromRunId ? `resumed from ${item.resumedFromRunId}` : '',
                item.runId ? `run ${item.runId}` : '',
                item.turnId ? `turn ${item.turnId}` : '',
                item.failureClass ?? '',
              ]
                .filter(Boolean)
                .join(' · '),
              limitText(item.summary, 1_000),
            ].join('\n'),
          ),
        ].join('\n\n'),
        16_000,
      );
    }
    case 'rive_workflow':
      return content.summary;
    case 'archived_tool_result':
      return `Archived tool result: ${content.status}`;
  }
}

function formatShellOutput(output: ShellOutput): string {
  if (output.mode === 'pty') {
    const terminal = ptyHumanTerminalText(output);
    return terminal ? `terminal:\n${terminal}` : '';
  }
  return [
    output.stdout ? `stdout:\n${output.stdout}` : '',
    output.stderr ? `stderr:\n${output.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatUnknownInline(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Fold line breaks into spaces so a summary can never split a one-line slot. */
export function collapseToSingleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

export function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... ${text.length - maxChars} chars truncated`;
}

export const markdownTheme: MarkdownTheme = {
  heading: ansi.accent,
  link: ansi.underline,
  linkUrl: ansi.dim,
  code: ansi.yellow,
  codeBlock: (text) => text,
  codeBlockBorder: ansi.dim,
  quote: ansi.dim,
  quoteBorder: ansi.dim,
  hr: ansi.dim,
  listBullet: ansi.accent,
  bold: ansi.bold,
  italic: ansi.italic,
  strikethrough: ansi.strikethrough,
  underline: ansi.underline,
};

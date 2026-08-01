import type { ReactNode } from 'react';
import { CodeBlock } from '@astryxdesign/core';

/**
 * Astryx CodeBlock for tool result bodies in chat.
 *
 * ChatToolCalls docs / InteractiveToolCalls examples put diffs and shell
 * output in CodeBlock via `resultDetail`. Product still owns live streams,
 * permission chrome, and rich cards (web search, subagent, PTY) — this is
 * only the code/text well.
 */
export function ToolCodeBlock(props: {
  code: string;
  language?: string;
  title?: string;
  maxHeight?: string | number;
}) {
  if (!props.code) return null;
  return (
    <CodeBlock
      code={props.code}
      language={props.language}
      title={props.title}
      maxHeight={props.maxHeight ?? '16rem'}
      width="100%"
      size="sm"
      isWrapped
    />
  );
}

/**
 * Enter animation for tool row detail / product trow body.
 * Matches ChatToolCalls group + ChatReasoning: grid 0fr→1fr over medium.
 * Astryx mounts row detail without that transition; product closes the gap.
 */
export function ToolDetailReveal(props: { children: ReactNode }) {
  return (
    <div className="maka-chat-tool-detail">
      <div className="maka-chat-tool-detail-inner">{props.children}</div>
    </div>
  );
}

import type { ReactNode } from 'react';
import { CodeBlock } from '@astryxdesign/core';

/** Quiet code/text well for tool resultDetail. */
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

/** Grid 0fr→1fr enter for tool detail (matches group/reasoning motion). */
export function ToolDetailReveal(props: { children: ReactNode }) {
  return (
    <div className="maka-chat-tool-detail">
      <div className="maka-chat-tool-detail-inner">{props.children}</div>
    </div>
  );
}

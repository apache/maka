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
      // Absolute, like every other length the type-scale convergence
      // touched. This was `16rem`, which rendered 208px under the old 13px
      // root and would have become 256px once the root went back to the
      // browser default. rem was never expressing "relative to the type
      // size" here — it was a habit that happened to be a density knob.
      maxHeight={props.maxHeight ?? '208px'}
      width="100%"
      // Astryx's `sm` is the supporting tier (12px); `md` is `--text-code-size`,
      // which is the same 0.875rem the product's own `--maka-text-code` well
      // resolves to. A tool detail that shows a diff beside a command surface
      // was rendering the two at 12px and 14px with different leadings — the
      // `sm` pin was the whole cause, so drop it rather than restyle either.
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

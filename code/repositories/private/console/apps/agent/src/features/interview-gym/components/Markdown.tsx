import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 仓库文档是给人读的 markdown：轻量样式映射即可；
// 站内 .md 相对链接在网页里没有目标，降级为纯文本，外链新标签打开
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[0.85em] [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-medium [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_strong]:font-semibold [&_table]:w-full [&_table]:text-xs [&_tbody_td]:border [&_tbody_td]:border-border [&_tbody_td]:px-2 [&_tbody_td]:py-1 [&_thead_th]:border [&_thead_th]:border-border [&_thead_th]:bg-muted/50 [&_thead_th]:px-2 [&_thead_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href && !href.endsWith(".md") ? (
              <a
                className="text-primary underline underline-offset-2"
                href={href}
                target="_blank"
                rel="noreferrer"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

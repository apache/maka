import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "./cn";

// ponytail: 用 components 映射替代 @tailwindcss/typography 插件，覆盖各 app 实际用到的元素
// 原 blog/toolbox 双份逐字节相同的 markdown.tsx 收编于此
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("text-[15px] leading-7 text-foreground/90", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: (p) => <h2 className="mt-10 mb-3 border-b pb-2 text-xl font-semibold" {...p} />,
          h3: (p) => <h3 className="mt-8 mb-3 text-lg font-semibold" {...p} />,
          h4: (p) => <h4 className="mt-6 mb-2 font-semibold" {...p} />,
          p: (p) => <p className="my-3" {...p} />,
          ul: (p) => <ul className="my-3 list-disc space-y-1.5 pl-6" {...p} />,
          ol: (p) => <ol className="my-3 list-decimal space-y-1.5 pl-6" {...p} />,
          blockquote: (p) => (
            <blockquote className="my-4 border-l-4 border-primary/40 bg-muted/50 px-4 py-1 text-muted-foreground" {...p} />
          ),
          a: (p) => <a className="text-primary underline underline-offset-4" {...p} />,
          strong: (p) => <strong className="font-semibold text-foreground" {...p} />,
          hr: (p) => <hr className="my-8 border-border" {...p} />,
          table: (p) => (
            <div className="my-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...p} />
            </div>
          ),
          th: (p) => <th className="border px-3 py-1.5 text-left font-medium" {...p} />,
          td: (p) => <td className="border px-3 py-1.5 align-top" {...p} />,
          code: ({ className: c, children, ...rest }) => {
            const isBlock = /language-/.test(c ?? "");
            if (isBlock) {
              return (
                <code className={cn("block overflow-x-auto p-4 text-[13px] leading-6", c)} {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]" {...rest}>
                {children}
              </code>
            );
          },
          pre: (p) => <pre className="my-4 rounded-lg bg-muted font-mono" {...p} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

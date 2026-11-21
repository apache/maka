import { TooltipProvider } from "@ggbdpq/console-ui";

// resume 区布局：源站根布局挂了 TooltipProvider，blog 按区补齐
export default function ResumeLayout({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

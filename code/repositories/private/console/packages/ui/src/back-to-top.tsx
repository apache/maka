"use client";
import * as React from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "./cn";

// BackToTop：滚过一屏出现，点击回顶

export function BackToTop({ className }: { className?: string }) {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > window.innerHeight);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label="回到顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className={cn(
        "fixed bottom-6 right-6 z-40 rounded-full border bg-background p-3 shadow-md transition-all hover:bg-accent",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
    >
      <ArrowUp className="size-4" />
    </button>
  );
}

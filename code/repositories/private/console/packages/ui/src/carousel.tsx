"use client";
import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn";

// Carousel：scroll-snap 轮播（展示用，自动播放缓迁）

export function Carousel({ items, className, itemClassName }: { items: React.ReactNode[]; className?: string; itemClassName?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);

  const scroll = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth, behavior: "smooth" });
  };

  return (
    <div className={cn("relative", className)}>
      <div ref={ref} className="flex snap-x snap-mandatory gap-4 overflow-x-auto rounded-lg [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item, i) => (
          <div key={i} className={cn("w-full shrink-0 snap-center rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground", itemClassName)}>
            {item}
          </div>
        ))}
      </div>
      <button type="button" onClick={() => scroll(-1)} aria-label="上一张" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border bg-background p-1.5 shadow hover:bg-accent">
        <ChevronLeft className="size-4" />
      </button>
      <button type="button" onClick={() => scroll(1)} aria-label="下一张" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border bg-background p-1.5 shadow hover:bg-accent">
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

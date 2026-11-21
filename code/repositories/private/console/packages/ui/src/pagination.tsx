"use client";
import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn";

// Pagination（ant-design Pagination）：页码 + 省略号

export function Pagination({
  current,
  total,
  pageSize = 10,
  onChange,
  className,
}: {
  current: number;
  total: number;
  pageSize?: number;
  onChange: (page: number) => void;
  className?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const pages: Array<number | "ellipsis"> = [];
  for (let i = 1; i <= pageCount; i++) {
    if (i === 1 || i === pageCount || Math.abs(i - current) <= 1) pages.push(i);
    else if (pages[pages.length - 1] !== "ellipsis") pages.push("ellipsis");
  }

  const itemCls = (active: boolean) =>
    cn(
      "flex size-8 items-center justify-center rounded-md text-sm transition-colors",
      active ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground hover:text-foreground",
    );

  return (
    <nav className={cn("flex items-center gap-1", className)} aria-label="分页">
      <button type="button" className={itemCls(false)} disabled={current === 1} onClick={() => onChange(current - 1)}>
        <ChevronLeft className="size-4" />
      </button>
      {pages.map((p, i) =>
        p === "ellipsis" ? (
          <span key={`e-${i}`} className="px-1 text-muted-foreground">
            …
          </span>
        ) : (
          <button key={p} type="button" className={itemCls(p === current)} onClick={() => onChange(p)}>
            {p}
          </button>
        ),
      )}
      <button type="button" className={itemCls(false)} disabled={current === pageCount} onClick={() => onChange(current + 1)}>
        <ChevronRight className="size-4" />
      </button>
    </nav>
  );
}

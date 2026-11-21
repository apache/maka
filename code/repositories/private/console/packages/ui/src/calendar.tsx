"use client";
import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn";

// Calendar（lite）：单月日历，选择日期（完整年月周面板缓迁，展示页用）

export function Calendar({
  value,
  onChange,
  className,
}: {
  value?: Date;
  onChange?: (d: Date) => void;
  className?: string;
}) {
  const [view, setView] = React.useState(() => {
    const v = value ?? new Date();
    return new Date(v.getFullYear(), v.getMonth(), 1);
  });

  const year = view.getFullYear();
  const month = view.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  const cells: Array<number | null> = [
    ...Array.from({ length: firstDay }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const isSame = (a: Date | undefined, d: number) =>
    a && a.getFullYear() === year && a.getMonth() === month && a.getDate() === d;

  return (
    <div className={cn("inline-block rounded-lg border p-3", className)}>
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={() => setView(new Date(year, month - 1, 1))} className="rounded p-1 hover:bg-accent">
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-sm font-medium">{year} 年 {month + 1} 月</span>
        <button type="button" onClick={() => setView(new Date(year, month + 1, 1))} className="rounded p-1 hover:bg-accent">
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground">
        {["日", "一", "二", "三", "四", "五", "六"].map((d) => (
          <span key={d} className="py-1">{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => (
          <button
            key={i}
            type="button"
            disabled={!d}
            onClick={() => d && onChange?.(new Date(year, month, d))}
            className={cn(
              "flex size-8 items-center justify-center rounded-md text-sm transition-colors",
              !d && "invisible",
              isSame(value, d ?? 0) && "bg-primary font-medium text-primary-foreground",
              !isSame(value, d ?? 0) && d && "hover:bg-accent",
              today.getFullYear() === year && today.getMonth() === month && today.getDate() === d && !isSame(value, d ?? 0) && "text-primary font-medium",
            )}
          >
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}

"use client";
import * as React from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "./cn";

// Transfer：双栏穿梭（搜索/全选，树形分页模式缓迁）

export interface TransferItem {
  id: string;
  label: string;
}

export function Transfer({
  items,
  target,
  onChange,
  className,
}: {
  items: TransferItem[];
  target: string[];
  onChange: (target: string[]) => void;
  className?: string;
}) {
  const [q, setQ] = React.useState("");
  const source = items.filter((i) => !target.includes(i.id) && i.label.toLowerCase().includes(q.toLowerCase()));
  const targetItems = target.map((id) => items.find((i) => i.id === id)).filter(Boolean) as TransferItem[];

  const listCls = "flex-1 rounded-lg border";
  const headerCls = "flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground";

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className={listCls}>
        <div className={headerCls}>
          <span>可选 {source.length}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => onChange([...target, ...source.map((s) => s.id)])}>
            全选
          </button>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索"
          className="w-full border-b bg-transparent px-3 py-1.5 text-sm outline-none"
        />
        <ul className="max-h-48 overflow-y-auto p-1 text-sm">
          {source.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => onChange([...target, i.id])}
                className="w-full rounded px-2 py-1 text-left hover:bg-accent"
              >
                {i.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          aria-label="移入"
          onClick={() => {}}
          className="hidden"
        />
        <ArrowRight className="size-4 text-muted-foreground" />
        <ArrowLeft className="size-4 text-muted-foreground" />
      </div>
      <div className={listCls}>
        <div className={headerCls}>
          <span>已选 {targetItems.length}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => onChange([])}>
            清空
          </button>
        </div>
        <ul className="max-h-56 overflow-y-auto p-1 text-sm">
          {targetItems.map((i) => (
            <li key={i.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-accent">
              <span>{i.label}</span>
              <button
                type="button"
                onClick={() => onChange(target.filter((t) => t !== i.id))}
                className="text-xs text-destructive hover:underline"
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

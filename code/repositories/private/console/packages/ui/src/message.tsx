"use client";
import * as React from "react";
import { cn } from "./cn";

export type MessageType = "info" | "success" | "warning" | "error";

const STYLE: Record<MessageType, string> = {
  info: "border-info/40",
  success: "border-success/40",
  warning: "border-warning/40",
  error: "border-destructive/40",
};

export interface MessageItem {
  id: number;
  type: MessageType;
  text: string;
}

// Message：受控消息条（等价 ant-design message 的最小实现）
// ponytail: 无退场动画（timeout 直接移除）；要退场动画时升级 framer-motion

export function useMessage() {
  const [items, setItems] = React.useState<MessageItem[]>([]);
  const show = React.useCallback((type: MessageType, text: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, type, text }]);
    window.setTimeout(() => setItems((prev) => prev.filter((m) => m.id !== id)), 2400);
  }, []);
  const host = <MessageHost items={items} />;
  return { show, host };
}

export function MessageHost({ items }: { items: MessageItem[] }) {
  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((m) => (
        <div
          key={m.id}
          className={cn("rounded-md border bg-background px-4 py-2 text-sm shadow-md animate-in fade-in-0 slide-in-from-top-2", STYLE[m.type])}
        >
          {m.text}
        </div>
      ))}
    </div>
  );
}
